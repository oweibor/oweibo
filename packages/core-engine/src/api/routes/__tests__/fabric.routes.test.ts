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
  const relaxations = {
    propose:     jest.fn().mockResolvedValue({ kind: 'pending_approval', proposalId: 'prop-1', quorum: 2 }),
    vote:        jest.fn().mockResolvedValue({ kind: 'pending', approvals: 1, quorum: 2 }),
    status:      jest.fn().mockResolvedValue({
      proposal: { id: 'prop-1', state: 'pending' }, votes: [], quorum: 2, approvals: 0,
    }),
    listPending: jest.fn().mockResolvedValue([{ id: 'prop-1', summary: 'Policy relaxation: indexing_scope' }]),
  };
  return { policy, upgrade, relaxations };
}

function makeApp(jwtTenant: string, opts: { withFlow?: boolean } = { withFlow: true }) {
  const stubs = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/fabric', createFabricRouter({
    policy:  stubs.policy  as unknown as Parameters<typeof createFabricRouter>[0]['policy'],
    upgrade: stubs.upgrade as unknown as Parameters<typeof createFabricRouter>[0]['upgrade'],
    ...(opts.withFlow !== false
      ? { relaxations: stubs.relaxations as unknown as NonNullable<Parameters<typeof createFabricRouter>[0]['relaxations']> }
      : {}),
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

  it('POST /policy/propose applies a tightening (through the flow when wired)', async () => {
    const { app, relaxations } = makeApp(TENANT);
    relaxations.propose.mockResolvedValueOnce({ kind: 'applied', policyVersion: '1', backfillRequired: true });
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/propose`)
      .send({ changes: [{ dimension: 'indexing_scope', value: { kind: 'indexing_scope', scope: 'metadata' } }] });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('applied');
    expect(res.body.backfillRequired).toBe(true);
  });

  it('POST /policy/propose opens a ballot for a relaxation — 202 pending_approval with the proposal id', async () => {
    const { app, relaxations } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/propose`)
      .send({ changes: [{ dimension: 'indexing_scope', value: { kind: 'indexing_scope', scope: 'full_content' } }] });
    expect(res.status).toBe(202);
    expect(res.body.kind).toBe('pending_approval');
    expect(res.body.proposalId).toBe('prop-1');
    expect(res.body.quorum).toBe(2);
    expect(relaxations.propose).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, proposerId: USER }),
    );
  });

  it('POST /policy/propose WITHOUT the ballot flow stays fail-closed: 409 needs_dual_control', async () => {
    const { app, policy } = makeApp(TENANT, { withFlow: false });
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

  it('there is NO HTTP route that applies a relaxation directly — apply happens server-side on quorum', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/apply`)
      .send({ votes: [{ principalId: 'a', approve: true }, { principalId: 'b', approve: true }] });
    // '/policy/relaxations/apply' matches the :proposalId GET pattern for
    // reads, but there is no POST at that shape other than /votes — 404.
    expect(res.status).toBe(404);
  });
});

describe('fabric routes — relaxation ballots (ADR-006 §3.4)', () => {
  it('lists pending ballots', async () => {
    const { app } = makeApp(TENANT);
    const res = await request(app).get(`/tenants/${TENANT}/fabric/policy/relaxations`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.proposals[0].id).toBe('prop-1');
  });

  it('returns a single ballot status, 404 when unknown', async () => {
    const { app, relaxations } = makeApp(TENANT);
    const ok = await request(app).get(`/tenants/${TENANT}/fabric/policy/relaxations/prop-1`);
    expect(ok.status).toBe(200);
    expect(ok.body.quorum).toBe(2);

    relaxations.status.mockResolvedValueOnce(null);
    const missing = await request(app).get(`/tenants/${TENANT}/fabric/policy/relaxations/nope`);
    expect(missing.status).toBe(404);
  });

  it('casts the vote as the JWT principal — voter identity is never a body field', async () => {
    const { app, relaxations } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/prop-1/votes`)
      .send({ vote: 'approve', voterUserId: 'someone-else' }); // ignored field
    expect(res.status).toBe(200);
    expect(relaxations.vote).toHaveBeenCalledWith(
      expect.objectContaining({ voterUserId: USER, vote: 'approve' }),
    );
  });

  it('rejects onBehalfOf outright — delegation is structurally unavailable (§3.4 rule 2)', async () => {
    const { app, relaxations } = makeApp(TENANT);
    const res = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/prop-1/votes`)
      .send({ vote: 'approve', onBehalfOf: '99999999-9999-4999-a999-999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('delegation_prohibited');
    expect(relaxations.vote).not.toHaveBeenCalled();
  });

  it('maps flow outcomes: applied passes through; already_resolved → 409; not_found → 404', async () => {
    const { app, relaxations } = makeApp(TENANT);
    relaxations.vote.mockResolvedValueOnce({ kind: 'applied', policyVersion: '3', backfillRequired: false });
    const applied = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/prop-1/votes`).send({ vote: 'approve' });
    expect(applied.status).toBe(200);
    expect(applied.body.kind).toBe('applied');

    relaxations.vote.mockResolvedValueOnce({ kind: 'already_resolved', state: 'promoted' });
    const resolved = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/prop-1/votes`).send({ vote: 'approve' });
    expect(resolved.status).toBe(409);

    relaxations.vote.mockResolvedValueOnce({ kind: 'not_found' });
    const missing = await request(app)
      .post(`/tenants/${TENANT}/fabric/policy/relaxations/nope/votes`).send({ vote: 'approve' });
    expect(missing.status).toBe(404);
  });

  it('answers 503 fail-closed on every ballot endpoint when the flow is unconfigured', async () => {
    const { app } = makeApp(TENANT, { withFlow: false });
    expect((await request(app).get(`/tenants/${TENANT}/fabric/policy/relaxations`)).status).toBe(503);
    expect((await request(app).get(`/tenants/${TENANT}/fabric/policy/relaxations/x`)).status).toBe(503);
    expect((await request(app).post(`/tenants/${TENANT}/fabric/policy/relaxations/x/votes`).send({ vote: 'approve' })).status).toBe(503);
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
