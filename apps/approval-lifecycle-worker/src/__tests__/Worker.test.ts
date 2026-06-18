/**
 * S.1 — ApprovalLifecycleWorker tests.
 *
 * Mocks the pg pool, SLA service, escalation engine, and notification router.
 * Verifies:
 *   - flag-off short-circuits (no claim, no work)
 *   - expired row → marks proposal expired, deletes state, fires expiry
 *   - mid-escalation row → resolves stage, dispatches, advances stage pointer
 *   - decided proposal → clears state, skipped
 *   - no approvers → parks until hard_expire_at
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  ApprovalLifecycleWorker,
  type IApprovalSlaService,
  type IEscalationEngine,
  type INotificationRouter,
} from '../Worker.js';
import type { ActionClass, ApprovalSlaPolicy } from '@oweibo/core-contracts';

// Stub policy — avoids importing across workspaces in this test.
function stubPolicy(tenantId: string, actionClass: string): ApprovalSlaPolicy {
  return {
    tenantId,
    // Cast: bare string is matched by prefix in production resolvers;
    // for this stub we accept any value and surface it as a structural
    // ActionClass | '*'.
    actionClass: actionClass as ActionClass | '*',
    initialNotifyAfterSeconds: 0,
    escalateAfterSeconds: [600, 1200],
    hardExpireAfterSeconds: 3600,
    approverResolution: 'role_based',
    approverConfig: { roles: ['tenant_admin'] },
    notificationChannels: [{ channelKind: 'in_app', config: {}, fireOn: ['initial', 'escalation', 'expiry'] }],
  };
}
const platformDefaultPolicy = stubPolicy;

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROPOSAL = '22222222-2222-2222-2222-222222222222';

interface QueryStub { match: string; rows: QueryResultRow[]; }

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rows.length : 0,
      command: '', oid: 0, fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

function makeSla(): {
  svc: IApprovalSlaService;
  advanceCalls: unknown[];
} {
  const advanceCalls: unknown[] = [];
  return {
    advanceCalls,
    svc: {
      resolvePolicy: jest.fn().mockImplementation(
        async (t, c) => platformDefaultPolicy(t, c),
      ),
      advanceStage: jest.fn().mockImplementation(async (args) => { advanceCalls.push(args); }),
    },
  };
}

function makeEsc(result: { approverUserIds: string[]; orgNodeIds?: string[]; chainExhausted?: boolean }): IEscalationEngine {
  return {
    resolveStage: jest.fn().mockResolvedValue({
      approverUserIds: result.approverUserIds,
      orgNodeIds: result.orgNodeIds ?? [],
      chainExhausted: result.chainExhausted ?? false,
    }),
  };
}

function makeRouter(): { router: INotificationRouter; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    router: {
      route: jest.fn().mockImplementation(async (req) => {
        calls.push(req);
        return { dispatched: req.recipients.length, suppressed: 0, failed: 0 };
      }),
    },
  };
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('ApprovalLifecycleWorker.runOnce', () => {
  it('short-circuits when flag is off', async () => {
    const { pool, calls } = makePool([]);
    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: [] });
    const { router } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => false, logger: silent,
    });
    const r = await w.runOnce();
    expect(r.processed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('claims due rows with FOR UPDATE SKIP LOCKED', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.approval_sla_state', rows: [] },
    ]);
    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: [] });
    const { router } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, logger: silent,
    });
    await w.runOnce();
    const claim = calls.find((c) => c.sql.includes('FROM oweibo.approval_sla_state'));
    expect(claim?.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('expires a proposal whose hard_expire_at is in the past', async () => {
    const now = new Date('2026-05-23T10:00:00Z');
    const expired = new Date('2026-05-23T09:00:00Z');
    const { pool, calls } = makePool([
      {
        match: 'FOR UPDATE SKIP LOCKED',
        rows: [{
          proposal_id: PROPOSAL,
          tenant_id: TENANT,
          current_stage: 3,
          hard_expire_at: expired,
          notified_approvers: ['u1'],
        }],
      },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{
          id: PROPOSAL, state: 'pending',
          action_class: 'financial.payment',
          user_id: 'author-1', summary: 'pay vendor',
        }],
      },
      // F.7 review: expireProposal now reads UPDATE rowCount; supply
      // a stub row so the mocked rowCount > 0 and the DELETE +
      // notification side effects proceed.
      { match: "SET state = 'expired'", rows: [{ id: PROPOSAL }] },
    ]);
    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: [] });
    const { router, calls: routerCalls } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, now: () => now, logger: silent,
    });
    const r = await w.runOnce();
    expect(r.expired).toBe(1);
    const upd = calls.find((c) => c.sql.includes(`SET state = 'expired'`));
    expect(upd).toBeDefined();
    const del = calls.find((c) => c.sql.includes('DELETE FROM oweibo.approval_sla_state'));
    expect(del).toBeDefined();
    const fired = routerCalls[0] as { fireEvent: string; recipients: { userId: string }[] };
    expect(fired.fireEvent).toBe('expiry');
    // Author + approver both notified.
    expect(fired.recipients.map((r) => r.userId)).toEqual(expect.arrayContaining(['author-1', 'u1']));
  });

  it('escalates: resolves stage, dispatches, advances pointer', async () => {
    const now = new Date('2026-05-23T10:00:00Z');
    const farFuture = new Date('2026-05-30T10:00:00Z');
    const { pool } = makePool([
      {
        match: 'FOR UPDATE SKIP LOCKED',
        rows: [{
          proposal_id: PROPOSAL,
          tenant_id: TENANT,
          current_stage: 0,
          hard_expire_at: farFuture,
          notified_approvers: [],
        }],
      },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{
          id: PROPOSAL, state: 'pending',
          action_class: 'financial.payment',
          user_id: 'author-1', summary: 'pay vendor',
        }],
      },
    ]);
    const { svc, advanceCalls } = makeSla();
    const esc = makeEsc({ approverUserIds: ['u1', 'u2'], orgNodeIds: ['cfo'], chainExhausted: false });
    const { router, calls: routerCalls } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, now: () => now, logger: silent,
    });
    const r = await w.runOnce();
    expect(r.escalated).toBe(1);
    const fired = routerCalls[0] as { fireEvent: string };
    expect(fired.fireEvent).toBe('initial');
    expect(advanceCalls).toHaveLength(1);
    const adv = advanceCalls[0] as { newStage: number; notifiedApprovers: string[] };
    expect(adv.newStage).toBe(1);
    expect(adv.notifiedApprovers).toEqual(['u1', 'u2']);
  });

  it('skips when proposal is already decided (clears SLA row)', async () => {
    const now = new Date('2026-05-23T10:00:00Z');
    const farFuture = new Date('2026-05-30T10:00:00Z');
    const { pool, calls } = makePool([
      {
        match: 'FOR UPDATE SKIP LOCKED',
        rows: [{
          proposal_id: PROPOSAL,
          tenant_id: TENANT,
          current_stage: 0,
          hard_expire_at: farFuture,
          notified_approvers: [],
        }],
      },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{
          id: PROPOSAL, state: 'executed_live',
          action_class: 'financial.payment',
          user_id: null, summary: 's',
        }],
      },
    ]);
    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: ['u1'] });
    const { router, calls: routerCalls } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, now: () => now, logger: silent,
    });
    const r = await w.runOnce();
    expect(r.skipped).toBe(1);
    expect(routerCalls).toHaveLength(0);
    const del = calls.find((c) => c.sql.includes('DELETE FROM oweibo.approval_sla_state'));
    expect(del).toBeDefined();
  });

  it('parks until hard_expire_at when no approvers can be resolved', async () => {
    const now = new Date('2026-05-23T10:00:00Z');
    const farFuture = new Date('2026-05-30T10:00:00Z');
    const { pool, calls } = makePool([
      {
        match: 'FOR UPDATE SKIP LOCKED',
        rows: [{
          proposal_id: PROPOSAL,
          tenant_id: TENANT,
          current_stage: 0,
          hard_expire_at: farFuture,
          notified_approvers: [],
        }],
      },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{
          id: PROPOSAL, state: 'pending',
          action_class: 'financial.payment',
          user_id: null, summary: 's',
        }],
      },
    ]);
    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: [], chainExhausted: true });
    const { router } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, now: () => now, logger: silent,
    });
    const r = await w.runOnce();
    expect(r.skipped).toBe(1);
    const park = calls.find((c) => c.sql.includes('SET next_action_at = hard_expire_at'));
    expect(park).toBeDefined();
  });

  // F.7 review (K): two failure/race scenarios in the expiry path.

  it('does NOT clear SLA state when the proposal load query fails', async () => {
    const now = new Date('2026-05-23T10:00:00Z');
    const expired = new Date('2026-05-23T09:00:00Z');
    const stubs: QueryStub[] = [
      {
        match: 'FOR UPDATE SKIP LOCKED',
        rows: [{
          proposal_id: PROPOSAL,
          tenant_id: TENANT,
          current_stage: 0,
          hard_expire_at: expired,
          notified_approvers: [],
        }],
      },
    ];
    const calls: { sql: string; params: unknown[] }[] = [];
    // Inline pool: throw on action_proposals SELECT after running the
    // claim, so loadProposal propagates the error (per the F.7-review
    // re-throw fix in loadProposal's catch).
    const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes('FROM oweibo.action_proposals')) {
        return Promise.reject(new Error('connection terminated'));
      }
      const stub = stubs.find((s) => sql.includes(s.match));
      return Promise.resolve({
        rows: stub ? stub.rows : [],
        rowCount: stub ? stub.rows.length : 0,
        command: '', oid: 0, fields: [],
      });
    };
    const client = { query: jest.fn().mockImplementation(queryFn), release: jest.fn() } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;

    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: [] });
    const { router, calls: routerCalls } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, now: () => now, logger: silent,
    });
    const r = await w.runOnce();
    // runOnce's per-row catch swallows the throw; the row stays under
    // its lease and the next tick retries. Critically, neither the
    // DELETE nor any router.route call should have fired.
    expect(r.processed).toBe(0);
    const del = calls.find((c) => c.sql.includes('DELETE FROM oweibo.approval_sla_state'));
    expect(del).toBeUndefined();
    expect(routerCalls).toHaveLength(0);
  });

  it('UPDATE matches zero rows (race): no DELETE, no expiry router event', async () => {
    const now = new Date('2026-05-23T10:00:00Z');
    const expired = new Date('2026-05-23T09:00:00Z');
    const { pool, calls } = makePool([
      {
        match: 'FOR UPDATE SKIP LOCKED',
        rows: [{
          proposal_id: PROPOSAL,
          tenant_id: TENANT,
          current_stage: 0,
          hard_expire_at: expired,
          notified_approvers: ['u1'],
        }],
      },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{
          id: PROPOSAL, state: 'pending',
          action_class: 'financial.payment',
          user_id: 'author-1', summary: 'pay vendor',
        }],
      },
      // UPDATE SET state='expired' matches 0 rows -- a concurrent
      // writer flipped the proposal out of 'pending' before we got
      // here. The default stub return (rows: []) gives rowCount=0.
      { match: "SET state = 'expired'", rows: [] },
    ]);
    const { svc } = makeSla();
    const esc = makeEsc({ approverUserIds: [] });
    const { router, calls: routerCalls } = makeRouter();
    const w = new ApprovalLifecycleWorker(pool, svc, esc, router, {
      isEnabled: () => true, now: () => now, logger: silent,
    });
    await w.runOnce();
    // Critical: no DELETE on approval_sla_state, no expiry notification.
    const del = calls.find((c) => c.sql.includes('DELETE FROM oweibo.approval_sla_state'));
    expect(del).toBeUndefined();
    const expiryRoute = (routerCalls as { fireEvent?: string }[]).find((c) => c.fireEvent === 'expiry');
    expect(expiryRoute).toBeUndefined();
  });
});
