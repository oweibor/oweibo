/**
 * K.9: fabric routes integration tests (stubbed services, house pattern).
 *
 *   - GET  /policy                → dimensions + version, each with its fixed category
 *   - POST /policy/simulate      → impact report passthrough; proposer is the JWT user
 *   - POST /policy/propose       → applied (tightening) / 409 needs_dual_control (relaxation)
 *   - POST /policy/propose       → 400 on unknown dimension and on kind/dimension mismatch
 *   - rollout: deployment read, canary/promote/rollback verb mapping (404/409)
 *   - tenant cross-check: 403 on mismatched URL tenant
 *   - NO relaxation-apply route exists (dual control not satisfiable from one caller)
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { createFabricRouter } from '../fabric.routes.js';
import { POLICY_DEFAULTS } from '../../../fabric/policy/contract.js';

const TENANT = '11111111-1111-4111-a111-111111111111';
const OTHER  = '22222222-2222-4222-b222-222222222222';
const USER   = 'cccccccc-3333-4333-c333-cccccccccccc';

function stubAuth(jwtTenantId: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as unknown as Record<string, unknown>;
    r['tenantId'] = jwtTenantId;
    r['userId']   = USER;
    r['scopes']   = [];
    next();
  };
}

function makeStubs() {
  const policy = {
    effectivePolicy: jest.fn().mockResolvedValue({ ...POLICY_DEFAULTS }),
    currentVersion:  jest.fn().mockResolvedValue('0'),
    simulate:        jest.fn().mockResolvedValue({
      classification: 'tightening', dualControlRequired: false,
      backfillRequired: true, affectedDocuments: 3, pathsChanged: ['indexing_scope'],
    }),
    propose:         jest.fn().mockResolvedValue({ kind: 'applied', policyVersion: '1', backfillRequired: true }),
  };
  const upgrade = {
    deployment:  jest.fn().mockResolvedValue({
      tenantId: TENANT, connectorId: 'slack', activeVersion: '1.0.0',
      state: 'stable', tenantCohort: 'cohort-a',
    }),
    beginCanary: jest.fn().mockResolvedValue({ ok: true }),
    promote:     jest.fn().mockResolvedValue({ ok: true }),
    rollback:    jest.fn().mockResolvedValue({ ok: true, retagged: 2 }),
  };
  return { policy, upgrade };
}

function makeApp(jwtTenant: string) {
  const stubs = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/fabric', createFabricRouter({
    policy:  stubs.policy  as unknown as Parameters<typeof createFabricRouter>[0]['policy'],
    upgrade: stubs.upgrade as unknown as Parameters<typeof createFabricRouter>[0]['upgrade'],
  }));
  return { app, ...stubs };
}

describe('fabric routes — policy plane', () => {
  it('GET /policy returns every dimension with its fixed category and the version', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app).get(`/tenants/${TENANT}/fabric/policy`);
    expect(res.status).toBe(200);
    expect(res.body.policyVersion).toBe('0');
    expect(res.body.dimensions).toHaveLength(8);
    const byDim = Object.fromEntries(
      (res.body.dimensions as Array<{ dimension: string; category: string }>).map((d) => [d.dimension, d.category]),
    );
    expect(byDim['data_residency']).toBe('compliance');
    expect(byDim['connector_enablement']).toBe('compliance');
    expect(byDim['retrieval_preference']).toBe('operational');
  });

  it('POST /policy/simulate forwards the change set with the JWT user as proposer', async () => {
    const { app, policy } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/simulate`)
      .send({ changes: [{ dimension: 'indexing_scope', value: { kind: 'indexing_scope', scope: 'metadata' } }] });
    expect(res.status).toBe(200);
    expect(res.body.classification).toBe('tightening');
    expect(policy.simulate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, proposerId: USER }),
    );
  });

  it('POST /policy/propose applies a tightening', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/propose`)
      .send({ changes: [{ dimension: 'indexing_scope', value: { kind: 'indexing_scope', scope: 'metadata' } }] });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('applied');
    expect(res.body.backfillRequired).toBe(true);
  });

  it('POST /policy/propose surfaces a relaxation as 409 needs_dual_control', async () => {
    const { app, policy } = makeApp(TENANT);
    policy.propose.mockResolvedValueOnce({ kind: 'needs_dual_control', classification: 'relaxation', quorum: 2 });
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/propose`)
      .send({ changes: [{ dimension: 'indexing_scope', value: { kind: 'indexing_scope', scope: 'full_content' } }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('needs_dual_control');
    expect(res.body.quorum).toBe(2);
  });

  it('rejects an unknown dimension and a kind/dimension mismatch with 400', async () => {
    const { app } = makeApp(TENANT);
    const unknown = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/propose`)
      .send({ changes: [{ dimension: 'nonsense', value: { kind: 'indexing_scope', scope: 'metadata' } }] });
    expect(unknown.status).toBe(400);

    // Mismatch would let a value be classified under one lattice and stored
    // under another — must be refused before it reaches the service.
    const mismatch = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/propose`)
      .send({ changes: [{ dimension: 'data_residency', value: { kind: 'indexing_scope', scope: 'metadata' } }] });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('invalid_change');
  });

  it('there is NO HTTP route that applies a relaxation — votes in a body would let one caller fabricate its second approver', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/apply`)
      .send({ votes: [{ principalId: 'a', approve: true }, { principalId: 'b', approve: true }] });
    expect(res.status).toBe(404);
  });
});

describe('fabric routes — rollout plane', () => {
  it('GET deployment returns the state plus the effective mint version', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app).get(`/tenants/${TENANT}/fabric/connectors/slack/deployment`);
    expect(res.status).toBe(200);
    expect(res.body.deployment.state).toBe('stable');
    expect(res.body.mintVersion).toBe('1.0.0');
  });

  it('GET deployment 404s when unregistered', async () => {
    const { app, upgrade } = makeApp(TENANT);
    upgrade.deployment.mockResolvedValueOnce(null);
    const res = await request(app).get(`/tenants/${TENANT}/fabric/connectors/nope/deployment`);
    expect(res.status).toBe(404);
  });

  it('canary/promote/rollback map service outcomes to 200 / 409 / 404', async () => {
    const { app, upgrade } = makeApp(TENANT);
    const canary = await request(app)
      .post(`/tenants/${TENANT}/fabric/connectors/slack/rollout/canary`)
      .send({ targetVersion: '2.0.0', canaryCohort: 'cohort-a' });
    expect(canary.status).toBe(200);
    expect(upgrade.beginCanary).toHaveBeenCalledWith(TENANT, {
      connectorId: 'slack', targetVersion: '2.0.0', canaryCohort: 'cohort-a',
    });

    upgrade.promote.mockResolvedValueOnce({ ok: false, error: 'illegal transition stable→stable' });
    const badPromote = await request(app).post(`/tenants/${TENANT}/fabric/connectors/slack/rollout/promote`);
    expect(badPromote.status).toBe(409);

    upgrade.rollback.mockResolvedValueOnce({ ok: false, retagged: 0, error: 'not_registered' });
    const badRollback = await request(app).post(`/tenants/${TENANT}/fabric/connectors/nope/rollout/rollback`);
    expect(badRollback.status).toBe(404);

    const rollback = await request(app).post(`/tenants/${TENANT}/fabric/connectors/slack/rollout/rollback`);
    expect(rollback.status).toBe(200);
    expect(rollback.body.retagged).toBe(2);
  });

  it('canary body is validated', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/connectors/slack/rollout/canary`)
      .send({ targetVersion: '' });
    expect(res.status).toBe(400);
  });
});

describe('fabric routes — tenant cross-check', () => {
  it('403s every surface when the JWT tenant differs from the URL tenant', async () => {
    const { app } = makeApp(OTHER); // JWT says OTHER; URL says TENANT
    const paths: Array<['get' | 'post', string]> = [
      ['get',  `/tenants/${TENANT}/fabric/policy`],
      ['post', `/tenants/${TENANT}/fabric/policy/simulate`],
      ['post', `/tenants/${TENANT}/fabric/policy/propose`],
      ['get',  `/tenants/${TENANT}/fabric/connectors/slack/deployment`],
      ['post', `/tenants/${TENANT}/fabric/connectors/slack/rollout/promote`],
    ];
    for (const [verb, path] of paths) {
      const res = verb === 'get' ? await request(app).get(path) : await request(app).post(path).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('tenant_mismatch');
    }
  });
});
