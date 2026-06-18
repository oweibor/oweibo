/**
 * F.4.3: tenantActions routes integration tests.
 *
 * Covers:
 *   - GET /plans/:planId — detail + 404.
 *   - GET /plans/:planId/actions — list with limit.
 *   - POST /:id/rollback — success 200 + failure 422.
 *   - POST /:id/rollback — 503 when orchestrator absent.
 *   - GET /:id/rollback/status — most-recent row + 404 when none.
 *   - Tenant cross-check (URL ≠ JWT → 403).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createTenantActionsRouter } from '../tenantActions.routes.js';

function stubAuth(jwtTenantId: string, userId = 'cccccccc-3333-4333-c333-cccccccccccc') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as unknown as Record<string, unknown>;
    r['tenantId'] = jwtTenantId;
    r['userId']   = userId;
    r['scopes']   = [];
    next();
  };
}

const TENANT     = '11111111-1111-4111-a111-111111111111';
const OTHER      = '22222222-2222-4222-b222-222222222222';
const PLAN_ID    = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ACTION_ID  = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function makeStubs() {
  const planDetail = {
    id: PLAN_ID, tenantId: TENANT, userId: null,
    originatingTaskId: null, title: 'pay vendors batch',
    atomicity: 'sequential_with_checkpoints', state: 'running',
    worstReversibility: 'reversible_with_cost',
    systems: ['payments'], dataDomains: ['financial'],
    estimatedCostUsdCents: 5000, estimatedReachUserCount: 1,
    planProposalId: null, createdAt: '2026-05-29T00:00:00.000Z',
    startedAt: '2026-05-29T00:00:01.000Z', completedAt: null,
    memberCount: 3,
  };
  const proposals = [
    { id: 'p1', tenantId: TENANT, userId: null, actionClass: 'financial.payment',
      actionId: 'a1', mode: 'require_approval', summary: 'pay vendor A',
      rollbackKind: 'reversible_with_cost', state: 'pending',
      createdAt: '2026-05-29T00:00:00.000Z', expiresAt: '2026-05-29T01:00:00.000Z',
      decidedAt: null, decidedBy: null, decisionReason: null },
  ];

  const registry = {
    getPlan: jest.fn().mockImplementation(async (_p: unknown, planId: string) =>
      planId === PLAN_ID ? planDetail : null),
    listPlanActions: jest.fn().mockResolvedValue(proposals),
  };
  const rollback = {
    execute: jest.fn().mockResolvedValue({
      success: true, state: 'fully_reverted',
      details: 'rolled back ledger entry',
      sideEffects: ['ledger:reversal:12345'],
      costUsdCents: 0,
    }),
    getStatus: jest.fn().mockImplementation(async (_t: string, id: string) =>
      id === ACTION_ID ? {
        executionId: 'e1', adapterName: 'postgres',
        reason: 'operator initiated', invokedBy: { type: 'human', id: 'u-1' },
        resultState: 'fully_reverted', resultDetails: 'ok',
        sideEffects: [], costUsdCents: 0,
        startedAt: '2026-05-29T00:00:00.000Z',
        completedAt: '2026-05-29T00:00:01.000Z',
      } : null),
  };
  return { registry, rollback, planDetail, proposals };
}

function makeApp(jwtTenant: string, withRollback = true) {
  const { registry, rollback, ...rest } = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/actions', createTenantActionsRouter({
    registry: registry as unknown as Parameters<typeof createTenantActionsRouter>[0]['registry'],
    ...(withRollback
      ? { rollbackOrchestrator: rollback as unknown as Parameters<typeof createTenantActionsRouter>[0]['rollbackOrchestrator'] }
      : {}),
  }));
  return { app, registry, rollback, ...rest };
}

describe('F.4.3: tenantActions routes', () => {
  // ── Plan reads ─────────────────────────────────────────────────────────
  it('GET /actions/plans/:planId returns plan detail with member count', async () => {
    const supertest = (await import('supertest')).default;
    const { app, registry } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/plans/${PLAN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe(PLAN_ID);
    expect(res.body.plan.memberCount).toBe(3);
    expect(res.body.plan.state).toBe('running');
    expect(registry.getPlan).toHaveBeenCalled();
  });

  it('GET /actions/plans/:planId returns 404 for unknown plan', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/actions/plans/99999999-9999-4999-9999-999999999999`,
    );
    expect(res.status).toBe(404);
  });

  it('GET /actions/plans/:planId/actions lists member proposals', async () => {
    const supertest = (await import('supertest')).default;
    const { app, registry } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/plans/${PLAN_ID}/actions?limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe(PLAN_ID);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.count).toBe(1);
    expect(registry.listPlanActions).toHaveBeenCalledWith(expect.anything(), PLAN_ID, { limit: 50 });
  });

  // ── Rollback ───────────────────────────────────────────────────────────
  it('POST /actions/:id/rollback returns 200 + RollbackResult on success', async () => {
    const supertest = (await import('supertest')).default;
    const { app, rollback } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/actions/${ACTION_ID}/rollback`)
      .send({ reason: 'operator escalation: ledger discrepancy' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.state).toBe('fully_reverted');
    expect(rollback.execute).toHaveBeenCalledWith({
      tenantId: TENANT,
      originalActionId: ACTION_ID,
      reason: 'operator escalation: ledger discrepancy',
      invokedBy: { type: 'human', id: 'cccccccc-3333-4333-c333-cccccccccccc' },
    });
  });

  it('POST /actions/:id/rollback returns 422 when adapter reports failure', async () => {
    const supertest = (await import('supertest')).default;
    const { app, rollback } = makeApp(TENANT);
    rollback.execute.mockResolvedValueOnce({
      success: false, state: 'failed',
      details: 'adapter refused: action declared irreversible',
      sideEffects: [], costUsdCents: 0,
    });
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/actions/${ACTION_ID}/rollback`)
      .send({ reason: 'attempt revert' });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
  });

  it('POST /actions/:id/rollback rejects empty reason with 400', async () => {
    const supertest = (await import('supertest')).default;
    const { app, rollback } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/actions/${ACTION_ID}/rollback`)
      .send({ reason: '' });
    expect(res.status).toBe(400);
    expect(rollback.execute).not.toHaveBeenCalled();
  });

  it('POST /actions/:id/rollback returns 503 when orchestrator absent', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT, /*withRollback=*/ false);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/actions/${ACTION_ID}/rollback`)
      .send({ reason: 'operator initiated' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('rollback_disabled');
  });

  it('GET /actions/:id/rollback/status returns most-recent row', async () => {
    const supertest = (await import('supertest')).default;
    const { app, rollback } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/${ACTION_ID}/rollback/status`);
    expect(res.status).toBe(200);
    expect(res.body.resultState).toBe('fully_reverted');
    expect(res.body.executionId).toBe('e1');
    expect(rollback.getStatus).toHaveBeenCalledWith(TENANT, ACTION_ID);
  });

  it('GET /actions/:id/rollback/status returns 404 when no rollback exists', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/actions/99999999-9999-4999-9999-999999999999/rollback/status`,
    );
    expect(res.status).toBe(404);
  });

  // ── Tenant cross-check ─────────────────────────────────────────────────
  it('returns 403 on plan reads when URL tenant ≠ JWT tenant', async () => {
    const supertest = (await import('supertest')).default;
    const { app, registry } = makeApp(OTHER);
    const res = await supertest(app).get(`/tenants/${TENANT}/actions/plans/${PLAN_ID}`);
    expect(res.status).toBe(403);
    expect(registry.getPlan).not.toHaveBeenCalled();
  });

  it('returns 403 on rollback POST when URL tenant ≠ JWT tenant', async () => {
    const supertest = (await import('supertest')).default;
    const { app, rollback } = makeApp(OTHER);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/actions/${ACTION_ID}/rollback`)
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(rollback.execute).not.toHaveBeenCalled();
  });
});
