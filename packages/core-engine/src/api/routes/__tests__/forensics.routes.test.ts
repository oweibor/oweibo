/**
 * F.4.1: forensics routes integration tests with stubbed HitlHandoffService,
 * storage adapter, and ActionReplayService.
 *
 * Covers:
 *   - List pagination shape (packets + nextCursor).
 *   - Tenant-param cross-check (URL ≠ JWT → 403).
 *   - Detail-by-id merges row metadata with parsed packet bytes.
 *   - Detail-by-plan navigates by planId (admin-web shape).
 *   - 404 on unknown id.
 *   - Download proxies storage bytes + sets X-Packet-Signature.
 *   - Resolve POST passes resolution through to service.
 *   - Replay 503 when ActionReplayService is unset.
 *   - Replay 202 + run status read-back when wired.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createForensicsRouter } from '../forensics.routes.js';

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
const PACKET_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const PLAN_ID   = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function makeStubs() {
  const rowSummary = {
    id: PACKET_ID,
    planId: PLAN_ID,
    state: 'open',
    triggerKind: 'auto_drift',
    createdAt: '2026-05-29T00:00:00.000Z',
    summary: 'plan failed verifier sev-3',
  };
  const row = {
    id: PACKET_ID,
    planId: PLAN_ID,
    triggerKind: 'auto_drift',
    triggeredBy: 'post_execution_verifier',
    summary: 'plan failed verifier sev-3',
    storageRef: 'forensics/11/forensic-deadbeef.json',
    signature: 'v1:abcd1234',
    byteSize: 4096,
    state: 'open',
    resolution: null,
    resolutionNotes: null,
    resolvedBy: null,
    resolvedAt: null,
    expiresAt: '2026-05-30T00:00:00.000Z',
    createdAt: '2026-05-29T00:00:00.000Z',
  };
  const packetBytes = Buffer.from(JSON.stringify({
    packetId: 'deadbeef',
    tenantId: TENANT,
    planId: PLAN_ID,
    summary: 'plan failed verifier sev-3',
    triggerKind: 'auto_drift',
    triggeredBy: 'post_execution_verifier',
    originalGoal: 'pay invoice',
    proposals: [{ proposalId: 'p1', actionClass: 'financial.payment', actionId: 'a1', mode: 'require_approval', state: 'rejected', summary: 'pay $50', payload: {}, rollbackKind: null, grantId: null, createdAt: '2026-05-29T00:00:00.000Z', decidedAt: '2026-05-29T00:00:00.000Z', decisionReason: 'sev-3 drift' }],
    executions: [],
    verifications: [{ proposalId: 'p1', verifierName: 'PostgresRowCount', timing: 'deferred', driftSeverity: 3, expected: { rows: 5 }, observed: { rows: 4 }, verifiedAt: '2026-05-29T00:00:00.000Z' }],
    rollbacks: [],
    inspections: [],
    contextSnapshots: {},
    suggestedActions: ['Review 1 failed action(s).'],
    builtAtMs: 1748476800000,
    schemaVersion: 1,
  }));

  const hitlHandoff = {
    listPaginated: jest.fn().mockResolvedValue({ rows: [rowSummary], nextCursor: null }),
    getById: jest.fn().mockImplementation(async (_t: string, id: string) =>
      id === PACKET_ID ? row : null,
    ),
    getByPlanId: jest.fn().mockImplementation(async (_t: string, planId: string) =>
      planId === PLAN_ID ? row : null,
    ),
    resolve: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    put: jest.fn(),
    get: jest.fn().mockResolvedValue(packetBytes),
  };
  const actionReplay = {
    replay: jest.fn().mockResolvedValue({
      runId: 'r1', status: 'complete',
      stepResults: [], totalSteps: 0, matchingSteps: 0, mismatchSteps: 0,
    }),
    getRun: jest.fn().mockImplementation(async (_t: string, runId: string) =>
      runId === 'r1' ? {
        runId: 'r1', planId: PLAN_ID, requestedBy: 'u-1', kind: 'shadow_full',
        mutation: null, status: 'complete', failureReason: null,
        resultSummary: { totalSteps: 1, matchingSteps: 1, mismatchSteps: 0 },
        startedAt: '2026-05-29T00:00:00.000Z',
        completedAt: '2026-05-29T00:00:01.000Z',
        createdAt: '2026-05-29T00:00:00.000Z',
      } : null,
    ),
  };
  return { hitlHandoff, storage, actionReplay, row, rowSummary, packetBytes };
}

function makeApp(jwtTenant: string, withReplay = true) {
  const { hitlHandoff, storage, actionReplay, ...rest } = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/forensics', createForensicsRouter({
    hitlHandoff:  hitlHandoff as unknown as Parameters<typeof createForensicsRouter>[0]['hitlHandoff'],
    storage:      storage      as unknown as Parameters<typeof createForensicsRouter>[0]['storage'],
    ...(withReplay
      ? { actionReplay: actionReplay as unknown as Parameters<typeof createForensicsRouter>[0]['actionReplay'] }
      : {}),
  }));
  return { app, hitlHandoff, storage, actionReplay, ...rest };
}

describe('F.4.1: forensics routes', () => {
  // ── List ────────────────────────────────────────────────────────────────
  it('GET /forensics returns paginated packets', async () => {
    const supertest = (await import('supertest')).default;
    const { app, hitlHandoff } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/forensics?limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.packets).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
    expect(hitlHandoff.listPaginated).toHaveBeenCalledWith(TENANT, { limit: 10 });
  });

  it('GET /forensics rejects cross-tenant access with 403', async () => {
    const supertest = (await import('supertest')).default;
    const { app, hitlHandoff } = makeApp(OTHER);
    const res = await supertest(app).get(`/tenants/${TENANT}/forensics`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_mismatch');
    expect(hitlHandoff.listPaginated).not.toHaveBeenCalled();
  });

  // ── Detail ─────────────────────────────────────────────────────────────
  it('GET /forensics/:id merges row metadata with parsed packet bytes', async () => {
    const supertest = (await import('supertest')).default;
    const { app, storage } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/forensics/${PACKET_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.packet.id).toBe(PACKET_ID);
    expect(res.body.packet.state).toBe('open');
    expect(res.body.packet.proposals).toHaveLength(1);
    expect(res.body.packet.verifications[0].driftSeverity).toBe(3);
    expect(res.body.packet.suggestedActions).toEqual(['Review 1 failed action(s).']);
    expect(storage.get).toHaveBeenCalledWith('forensics/11/forensic-deadbeef.json');
  });

  it('GET /forensics/:id returns 404 for unknown packet', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/forensics/99999999-9999-4999-9999-999999999999`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('GET /forensics/by-plan/:planId resolves by planId', async () => {
    const supertest = (await import('supertest')).default;
    const { app, hitlHandoff } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/forensics/by-plan/${PLAN_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.packet.planId).toBe(PLAN_ID);
    expect(hitlHandoff.getByPlanId).toHaveBeenCalledWith(TENANT, PLAN_ID);
  });

  // ── Download ───────────────────────────────────────────────────────────
  it('GET /forensics/:id/download proxies storage bytes + sets signature header', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/forensics/${PACKET_ID}/download`);
    expect(res.status).toBe(200);
    expect(res.headers['x-packet-signature']).toBe('v1:abcd1234');
    expect(res.headers['content-disposition']).toContain(`forensic-${PACKET_ID}.json`);
    expect(JSON.parse(res.text).packetId).toBe('deadbeef');
  });

  // ── Resolve ────────────────────────────────────────────────────────────
  it('POST /forensics/:id/resolve threads resolution through service', async () => {
    const supertest = (await import('supertest')).default;
    const { app, hitlHandoff } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/forensics/${PACKET_ID}/resolve`)
      .send({ resolution: 'aborted', notes: 'operator aborted: payment vendor outage' });
    expect(res.status).toBe(200);
    expect(hitlHandoff.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      forensicPacketRowId: PACKET_ID,
      resolution: 'aborted',
      resolvedByUserId: 'cccccccc-3333-4333-c333-cccccccccccc',
      notes: 'operator aborted: payment vendor outage',
    });
  });

  it('POST /forensics/:id/resolve rejects unknown resolution kind', async () => {
    const supertest = (await import('supertest')).default;
    const { app, hitlHandoff } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/forensics/${PACKET_ID}/resolve`)
      .send({ resolution: 'made-up-string' });
    expect(res.status).toBe(400);
    expect(hitlHandoff.resolve).not.toHaveBeenCalled();
  });

  // ── Replay ─────────────────────────────────────────────────────────────
  it('POST /forensics/:id/replay returns 503 when ActionReplayService is unset', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT, /*withReplay=*/ false);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/forensics/${PACKET_ID}/replay`)
      .send({ kind: 'shadow_full' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('replay_disabled');
  });

  it('POST /forensics/:id/replay returns 202 + result when wired', async () => {
    const supertest = (await import('supertest')).default;
    const { app, actionReplay } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/forensics/${PACKET_ID}/replay`)
      .send({ kind: 'shadow_full' });
    expect(res.status).toBe(202);
    expect(res.body.runId).toBe('r1');
    expect(actionReplay.replay).toHaveBeenCalledWith({
      tenantId: TENANT,
      planId: PLAN_ID,
      requestedByUserId: 'cccccccc-3333-4333-c333-cccccccccccc',
      kind: 'shadow_full',
    });
  });

  it('POST /forensics/:id/replay rejects shadow_step without proposalId', async () => {
    const supertest = (await import('supertest')).default;
    const { app, actionReplay } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/forensics/${PACKET_ID}/replay`)
      .send({ kind: 'shadow_step' });
    expect(res.status).toBe(400);
    expect(actionReplay.replay).not.toHaveBeenCalled();
  });

  it('POST /forensics/:id/replay rejects what_if without mutation', async () => {
    const supertest = (await import('supertest')).default;
    const { app, actionReplay } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/forensics/${PACKET_ID}/replay`)
      .send({ kind: 'what_if' });
    expect(res.status).toBe(400);
    expect(actionReplay.replay).not.toHaveBeenCalled();
  });

  it('GET /forensics/:id/replay/:runId reads back replay run', async () => {
    const supertest = (await import('supertest')).default;
    const { app, actionReplay } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/forensics/${PACKET_ID}/replay/r1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('complete');
    expect(res.body.resultSummary.matchingSteps).toBe(1);
    expect(actionReplay.getRun).toHaveBeenCalledWith(TENANT, 'r1');
  });

  it('GET /forensics/:id/replay/:runId returns 404 for unknown run', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/forensics/${PACKET_ID}/replay/no-such-run`,
    );
    expect(res.status).toBe(404);
  });
});
