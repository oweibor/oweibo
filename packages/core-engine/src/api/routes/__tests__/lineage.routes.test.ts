/**
 * F.4.2: lineage routes integration tests.
 *
 * Covers:
 *   - Plan tree GET returns nodes + count.
 *   - Action lineage filtered query.
 *   - Decision history returns root + descendants, 404 when unknown.
 *   - Tenant-param cross-check (URL ≠ JWT → 403).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createLineageRouter } from '../lineage.routes.js';

function stubAuth(jwtTenantId: string, userId = 'u-1') {
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
const PLAN_ID     = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ACTION_ID   = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const DECISION_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

function fakeNode(over: Partial<Record<string, unknown>> = {}) {
  return {
    nodeId: 'n-' + Math.random().toString(36).slice(2, 8),
    planId: PLAN_ID,
    parentNodeId: null,
    kind: 'gate_decision',
    producer: { type: 'gate', id: 'plan-gate' },
    summary: 'gate approved',
    detail: {},
    recordedAt: '2026-05-29T00:00:00.000Z',
    ...over,
  };
}

function makeStubs() {
  const planNodes = [fakeNode({ kind: 'gate_decision' }), fakeNode({ kind: 'execution' })];
  const actionNodes = [fakeNode({ kind: 'execution', producer: { type: 'agent', id: ACTION_ID } })];
  const rootDecision = fakeNode({ nodeId: DECISION_ID, kind: 'gate_decision' });
  const descendants = [
    fakeNode({ parentNodeId: DECISION_ID, kind: 'execution' }),
    fakeNode({ parentNodeId: DECISION_ID, kind: 'verification' }),
  ];

  const lineage = {
    read: jest.fn().mockResolvedValue(planNodes),
    readActionLineage: jest.fn().mockResolvedValue(actionNodes),
    readDecisionHistory: jest.fn().mockImplementation(async (_t: string, id: string) =>
      id === DECISION_ID
        ? { decision: rootDecision, descendants }
        : { decision: null, descendants: [] },
    ),
  };
  return { lineage, planNodes, actionNodes, rootDecision, descendants };
}

function makeApp(jwtTenant: string) {
  const { lineage, ...rest } = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/lineage', createLineageRouter({
    lineage: lineage as unknown as Parameters<typeof createLineageRouter>[0]['lineage'],
  }));
  return { app, lineage, ...rest };
}

describe('F.4.2: lineage routes', () => {
  it('GET /lineage/plans/:planId returns nodes + count', async () => {
    const supertest = (await import('supertest')).default;
    const { app, lineage, planNodes } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/lineage/plans/${PLAN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe(PLAN_ID);
    expect(res.body.nodes).toHaveLength(planNodes.length);
    expect(res.body.nodeCount).toBe(planNodes.length);
    expect(lineage.read).toHaveBeenCalledWith(TENANT, PLAN_ID);
  });

  it('GET /lineage/actions/:actionId returns filtered nodes', async () => {
    const supertest = (await import('supertest')).default;
    const { app, lineage } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/lineage/actions/${ACTION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.actionId).toBe(ACTION_ID);
    expect(res.body.nodes).toHaveLength(1);
    expect(lineage.readActionLineage).toHaveBeenCalledWith(TENANT, ACTION_ID);
  });

  it('GET /lineage/decisions/:decisionId returns root + descendants', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/lineage/decisions/${DECISION_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.decision.nodeId).toBe(DECISION_ID);
    expect(res.body.descendants).toHaveLength(2);
    expect(res.body.descendantCount).toBe(2);
  });

  it('GET /lineage/decisions/:decisionId returns 404 for unknown decision', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/lineage/decisions/99999999-9999-4999-9999-999999999999`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('returns 403 when URL tenant ≠ JWT tenant', async () => {
    const supertest = (await import('supertest')).default;
    const { app, lineage } = makeApp(OTHER);
    const res = await supertest(app).get(`/tenants/${TENANT}/lineage/plans/${PLAN_ID}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_mismatch');
    expect(lineage.read).not.toHaveBeenCalled();
  });

  it('returns 403 on all three endpoints on tenant mismatch', async () => {
    const supertest = (await import('supertest')).default;
    const { app, lineage } = makeApp(OTHER);
    const a = await supertest(app).get(`/tenants/${TENANT}/lineage/actions/${ACTION_ID}`);
    const d = await supertest(app).get(`/tenants/${TENANT}/lineage/decisions/${DECISION_ID}`);
    expect(a.status).toBe(403);
    expect(d.status).toBe(403);
    expect(lineage.readActionLineage).not.toHaveBeenCalled();
    expect(lineage.readDecisionHistory).not.toHaveBeenCalled();
  });
});
