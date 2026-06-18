/**
 * F.4.4: policies routes integration tests.
 *
 * For each of {sla, multiparty, ratelimit, quota}:
 *   - GET    /policies/:domain                  list override rows
 *   - GET    /policies/:domain/:actionClass     effective resolution
 *   - PUT    /policies/:domain/:actionClass     upsert; happy path
 *   - PUT    /policies/:domain/:actionClass     below-floor → 400 policy_below_platform_floor
 *   - DELETE /policies/:domain/:actionClass     remove override
 *
 * Plus cross-cutting:
 *   - unknown :domain → 404
 *   - tenant cross-check 403 on every domain × method
 *   - PolicyBelowFloorError surface (route surfaces violations[])
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createPoliciesRouter } from '../policies.routes.js';
import { PolicyBelowFloorError } from '../../../action/PolicyFloor.js';

function stubAuth(jwtTenantId: string, userId = 'cccccccc-3333-4333-c333-cccccccccccc') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as unknown as Record<string, unknown>;
    r['tenantId'] = jwtTenantId;
    r['userId']   = userId;
    r['scopes']   = [];
    next();
  };
}

const TENANT = '11111111-1111-4111-a111-111111111111';
const OTHER  = '22222222-2222-4222-b222-222222222222';
const CLASS  = 'financial.payment';

function makeStubs() {
  const sla = {
    listPolicies:   jest.fn().mockResolvedValue([{ tenantId: TENANT, actionClass: CLASS, hardExpireAfterSeconds: 3600 }]),
    resolvePolicy:  jest.fn().mockResolvedValue({ tenantId: TENANT, actionClass: CLASS, hardExpireAfterSeconds: 3600 }),
    upsertPolicy:   jest.fn().mockImplementation(async (t: string, c: string, p: unknown) => ({ tenantId: t, actionClass: c, ...p as object })),
    deletePolicy:   jest.fn().mockResolvedValue(true),
  };
  const multiparty = {
    listPolicies:   jest.fn().mockResolvedValue([{ tenantId: TENANT, actionClass: CLASS, quorum: 2 }]),
    resolvePolicy:  jest.fn().mockResolvedValue({ tenantId: TENANT, actionClass: CLASS, quorum: 2 }),
    upsertPolicy:   jest.fn().mockImplementation(async (t: string, c: string, p: unknown) => ({ tenantId: t, actionClass: c, ...p as object })),
    deletePolicy:   jest.fn().mockResolvedValue(true),
  };
  const ratelimit = {
    listPolicies:   jest.fn().mockResolvedValue([{ tenantId: TENANT, actionClass: CLASS, perMinute: 5 }]),
    resolve:        jest.fn().mockResolvedValue({ tenantId: TENANT, actionClass: CLASS, perMinute: 5 }),
    upsertPolicy:   jest.fn().mockImplementation(async (t: string, c: string, p: unknown) => ({ tenantId: t, actionClass: c, ...p as object })),
    deletePolicy:   jest.fn().mockResolvedValue(true),
  };
  const quota = {
    listPolicies:   jest.fn().mockResolvedValue([{
      tenantId: TENANT, scope: CLASS, quotaKind: 'action_count_per_class',
      window: 'day', limitValue: 10, coldStartDurationDays: 30, enforcementMode: 'hard',
    }]),
    upsertPolicy:   jest.fn().mockImplementation(async (t: string, p: unknown) => ({ tenantId: t, ...p as object })),
    deletePolicy:   jest.fn().mockResolvedValue(true),
  };
  return { sla, multiparty, ratelimit, quota };
}

function makeApp(jwtTenant: string) {
  const stubs = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/actions/policies', createPoliciesRouter({
    sla:        stubs.sla        as unknown as Parameters<typeof createPoliciesRouter>[0]['sla'],
    multiparty: stubs.multiparty as unknown as Parameters<typeof createPoliciesRouter>[0]['multiparty'],
    ratelimit:  stubs.ratelimit  as unknown as Parameters<typeof createPoliciesRouter>[0]['ratelimit'],
    quota:      stubs.quota      as unknown as Parameters<typeof createPoliciesRouter>[0]['quota'],
  }));
  return { app, ...stubs };
}

// ── Valid payloads (above platform floor) ───────────────────────────────

const VALID_SLA = {
  initialNotifyAfterSeconds: 30,
  escalateAfterSeconds: [600, 1800],
  hardExpireAfterSeconds: 7200,
  approverResolution: 'org_graph',
  approverConfig: { chain: 'cfo' },
};
const VALID_MP = {
  quorum: 2, dissentVetoes: true, allowGrants: false,
  maxGrantDurationSeconds: 3600, maxGrantActionCount: 10, allowDelegation: false,
};
const VALID_RL = {
  perMinute: 5, perHour: 50, perDay: 200, burstAllowance: 1,
  coldStartMultiplier: 0.10, coldStartDurationDays: 30, enforcementMode: 'soft',
};
const VALID_Q = {
  quotaKind: 'action_count_per_class', window: 'day', limitValue: 10,
  coldStartLimit: 1, coldStartDurationDays: 30, enforcementMode: 'hard',
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('F.4.4 policies routes — list', () => {
  it.each(['sla', 'multiparty', 'ratelimit', 'quota'])(
    'GET /policies/%s returns the tenant override rows',
    async (domain) => {
      const supertest = (await import('supertest')).default;
      const { app } = makeApp(TENANT);
      const res = await supertest(app).get(`/tenants/${TENANT}/actions/policies/${domain}`);
      expect(res.status).toBe(200);
      expect(res.body.domain).toBe(domain);
      expect(res.body.policies).toHaveLength(1);
      expect(res.body.count).toBe(1);
    },
  );

  it('GET /policies/unknown returns 404', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/policies/foobar`);
    expect(res.status).toBe(404);
  });
});

describe('F.4.4 policies routes — effective', () => {
  it('GET /policies/sla/:class returns the resolved SLA policy', async () => {
    const supertest = (await import('supertest')).default;
    const { app, sla } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/policies/sla/${CLASS}`);
    expect(res.status).toBe(200);
    expect(res.body.effective.actionClass).toBe(CLASS);
    expect(sla.resolvePolicy).toHaveBeenCalledWith(TENANT, CLASS);
  });

  it('GET /policies/quota/:class returns the tenant rows for that scope (kind/window grid)', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quota } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/policies/quota/${CLASS}`);
    expect(res.status).toBe(200);
    expect(res.body.effective).toHaveLength(1);
    expect(quota.listPolicies).toHaveBeenCalled();
  });
});

describe('F.4.4 policies routes — upsert (happy path)', () => {
  it('PUT /policies/sla/:class with above-floor body returns 200', async () => {
    const supertest = (await import('supertest')).default;
    const { app, sla } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/sla/${CLASS}`)
      .send(VALID_SLA);
    expect(res.status).toBe(200);
    expect(sla.upsertPolicy).toHaveBeenCalledWith(
      TENANT, CLASS,
      expect.objectContaining({ hardExpireAfterSeconds: 7200 }),
      expect.objectContaining({ createdBy: expect.any(String) }),
    );
  });

  it('PUT /policies/multiparty/:class accepts a valid policy', async () => {
    const supertest = (await import('supertest')).default;
    const { app, multiparty } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/multiparty/${CLASS}`)
      .send(VALID_MP);
    expect(res.status).toBe(200);
    expect(multiparty.upsertPolicy).toHaveBeenCalled();
  });

  it('PUT /policies/ratelimit/:class accepts a valid policy', async () => {
    const supertest = (await import('supertest')).default;
    const { app, ratelimit } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/ratelimit/${CLASS}`)
      .send(VALID_RL);
    expect(res.status).toBe(200);
    expect(ratelimit.upsertPolicy).toHaveBeenCalled();
  });

  it('PUT /policies/quota/:class accepts a valid policy', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quota } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/quota/${CLASS}`)
      .send(VALID_Q);
    expect(res.status).toBe(200);
    expect(quota.upsertPolicy).toHaveBeenCalledWith(TENANT, expect.objectContaining({
      scope: CLASS, quotaKind: 'action_count_per_class', window: 'day',
    }));
  });
});

describe('F.4.4 policies routes — upsert (Zod schema rejects)', () => {
  it('PUT /policies/sla rejects missing required fields with 400', async () => {
    const supertest = (await import('supertest')).default;
    const { app, sla } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/sla/${CLASS}`)
      .send({ initialNotifyAfterSeconds: 30 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(sla.upsertPolicy).not.toHaveBeenCalled();
  });

  it('PUT /policies/multiparty rejects quorum > 10 (DB CHECK boundary)', async () => {
    const supertest = (await import('supertest')).default;
    const { app, multiparty } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/multiparty/${CLASS}`)
      .send({ ...VALID_MP, quorum: 11 });
    expect(res.status).toBe(400);
    expect(multiparty.upsertPolicy).not.toHaveBeenCalled();
  });
});

describe('F.4.4 policies routes — upsert (below floor → policy_below_platform_floor)', () => {
  it('PUT /policies/sla rejects hardExpireAfterSeconds < 3600 with structured floor error', async () => {
    const supertest = (await import('supertest')).default;
    const { app, sla } = makeApp(TENANT);
    sla.upsertPolicy.mockRejectedValueOnce(new PolicyBelowFloorError('sla', CLASS, [{
      field: 'hardExpireAfterSeconds', message: 'below floor',
      floor: 3600, supplied: 1000,
    }]));
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/sla/${CLASS}`)
      .send({ ...VALID_SLA, hardExpireAfterSeconds: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('policy_below_platform_floor');
    expect(res.body.domain).toBe('sla');
    expect(res.body.violations).toHaveLength(1);
    expect(res.body.violations[0].field).toBe('hardExpireAfterSeconds');
  });

  it('PUT /policies/multiparty surfaces every violation in one response', async () => {
    const supertest = (await import('supertest')).default;
    const { app, multiparty } = makeApp(TENANT);
    multiparty.upsertPolicy.mockRejectedValueOnce(new PolicyBelowFloorError('multiparty', CLASS, [
      { field: 'quorum', message: 'quorum below floor', floor: 2, supplied: 1 },
      { field: 'maxGrantDurationSeconds', message: 'too long', floor: 86400, supplied: 1000000 },
    ]));
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/multiparty/${CLASS}`)
      .send({ ...VALID_MP, quorum: 1, maxGrantDurationSeconds: 1000000 });
    expect(res.status).toBe(400);
    expect(res.body.violations).toHaveLength(2);
    expect(res.body.violations.map((v: { field: string }) => v.field).sort()).toEqual([
      'maxGrantDurationSeconds', 'quorum',
    ]);
  });

  it('PUT /policies/ratelimit rejects perMinute=0', async () => {
    const supertest = (await import('supertest')).default;
    const { app, ratelimit } = makeApp(TENANT);
    ratelimit.upsertPolicy.mockRejectedValueOnce(new PolicyBelowFloorError('ratelimit', CLASS, [{
      field: 'perMinute', message: 'below', floor: 1, supplied: 0,
    }]));
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/ratelimit/${CLASS}`)
      .send({ ...VALID_RL, perMinute: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('policy_below_platform_floor');
  });

  it('PUT /policies/quota rejects limitValue=0', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quota } = makeApp(TENANT);
    quota.upsertPolicy.mockRejectedValueOnce(new PolicyBelowFloorError('quota', CLASS, [{
      field: 'limitValue', message: 'below', floor: 1, supplied: 0,
    }]));
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/actions/policies/quota/${CLASS}`)
      .send({ ...VALID_Q, limitValue: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('policy_below_platform_floor');
  });
});

describe('F.4.4 policies routes — delete', () => {
  it('DELETE /policies/sla/:class removes the override', async () => {
    const supertest = (await import('supertest')).default;
    const { app, sla } = makeApp(TENANT);
    const res = await supertest(app).delete(`/tenants/${TENANT}/actions/policies/sla/${CLASS}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sla.deletePolicy).toHaveBeenCalledWith(TENANT, CLASS);
  });

  it('DELETE /policies/sla/:class returns 404 when nothing to delete', async () => {
    const supertest = (await import('supertest')).default;
    const { app, sla } = makeApp(TENANT);
    sla.deletePolicy.mockResolvedValueOnce(false);
    const res = await supertest(app).delete(`/tenants/${TENANT}/actions/policies/sla/${CLASS}`);
    expect(res.status).toBe(404);
  });

  it('DELETE /policies/quota requires kind + window query params', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quota } = makeApp(TENANT);
    const res = await supertest(app).delete(`/tenants/${TENANT}/actions/policies/quota/${CLASS}`);
    expect(res.status).toBe(400);
    expect(quota.deletePolicy).not.toHaveBeenCalled();
  });

  it('DELETE /policies/quota succeeds with kind + window', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quota } = makeApp(TENANT);
    const res = await supertest(app).delete(
      `/tenants/${TENANT}/actions/policies/quota/${CLASS}?kind=action_count_per_class&window=day`,
    );
    expect(res.status).toBe(200);
    expect(quota.deletePolicy).toHaveBeenCalledWith(TENANT, {
      quotaKind: 'action_count_per_class', scope: CLASS, window: 'day',
    });
  });
});

describe('F.4.4 policies routes — tenant cross-check', () => {
  const domains = ['sla', 'multiparty', 'ratelimit', 'quota'] as const;
  const methods: Array<['GET' | 'PUT' | 'DELETE', (path: string, app: express.Express) => Promise<{ status: number }>]> = [
    ['GET',    async (p, a) => (await import('supertest')).default(a).get(p)],
    ['PUT',    async (p, a) => (await import('supertest')).default(a).put(p).send(VALID_SLA)],
    ['DELETE', async (p, a) => (await import('supertest')).default(a).delete(p)],
  ];

  for (const domain of domains) {
    for (const [method, run] of methods) {
      it(`${method} /policies/${domain} → 403 when JWT.tenantId ≠ URL.tenantId`, async () => {
        const { app } = makeApp(OTHER);
        const res = await run(`/tenants/${TENANT}/actions/policies/${domain}/${CLASS}`, app);
        expect(res.status).toBe(403);
      });
    }
  }
});
