/**
 * Unit tests for ActionTrustLadder.
 *
 * Uses a mock pg Pool/PoolClient pair. Covers:
 *   - feature flag gating (off → byte-identical to today)
 *   - shadow-only mode (writes proposal, returns 'execute')
 *   - platform-default matrix across all three age × score tiers
 *   - explicit state precedence over the matrix
 *   - auto-promotion conditions
 *   - promote/reject contracts
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ActionTrustLadder } from '../ActionTrustLadder.js';
import type {
  ActionContext,
  ActionClass,
  GatePrincipal,
  TenantReadinessSnapshot,
} from '@oweibo/core-contracts';

// ── Mock helpers ───────────────────────────────────────────────────────────

interface QueryStub {
  // string the SQL must contain (case-sensitive) to match this stub
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rows.length : 0,
      command: '',
      oid: 0,
      fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = {
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

function makeSnapshot(
  accountAgeDays: number,
  classScore: number,
  cls: ActionClass,
): TenantReadinessSnapshot {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    accountAgeDays,
    actionClassScores: { [cls]: classScore },
    snapshotAt: new Date().toISOString(),
    sourceSig: 'test',
  };
}

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  const actionClass = overrides.actionClass ?? 'write.external_api.nonprod';
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    actionClass,
    actionId: 'test-action-1',
    summary: 'test action',
    payload: { foo: 'bar' },
    calibrationSnapshot: overrides.calibrationSnapshot ?? makeSnapshot(0, 0, actionClass),
    ...overrides,
  };
}

// ── S.2 rate-limit integration ────────────────────────────────────────────

describe('ActionTrustLadder.gate — S.2 rate limiter hook', () => {
  // 'read.local' is platform-default 'execute' across all tiers, so the gate
  // bypasses the proposal-write path and we don't need to stub the INSERT.
  const cleanCtx = () => makeCtx({
    actionClass: 'read.local',
    calibrationSnapshot: makeSnapshot(60, 0.95, 'read.local'),
  });

  it('passes through when no rate limiter is wired (backwards compat)', async () => {
    const { pool } = makePool([]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const r = await ladder.gate(cleanCtx());
    expect(r.mode).toBe('execute');
  });

  it('returns rate_limited when limiter reports soft throttle', async () => {
    const { pool } = makePool([]);
    const ladder = new ActionTrustLadder(pool, {
      isEnabled: () => true,
      rateLimiter: {
        async tryConsume() { return { kind: 'soft', retryAfterMs: 1500, limitingWindow: 'minute' }; },
      },
    });
    const r = await ladder.gate(cleanCtx());
    expect(r.mode).toBe('rate_limited');
    if (r.mode === 'rate_limited') expect(r.retryAfterMs).toBe(1500);
  });

  it('returns forbidden when limiter reports hard throttle', async () => {
    const { pool } = makePool([]);
    const ladder = new ActionTrustLadder(pool, {
      isEnabled: () => true,
      rateLimiter: {
        async tryConsume() { return { kind: 'hard', reason: 'rate_limit_exceeded' }; },
      },
    });
    const r = await ladder.gate(cleanCtx());
    expect(r.mode).toBe('forbidden');
    if (r.mode === 'forbidden') expect(r.reason).toBe('rate_limit_exceeded');
  });

  it('bypasses rate-limit check in shadow-only mode', async () => {
    const { pool } = makePool([]);
    let consumeCalls = 0;
    const ladder = new ActionTrustLadder(pool, {
      isEnabled: () => true,
      isShadowOnly: () => true,
      rateLimiter: {
        async tryConsume() {
          consumeCalls += 1;
          return { kind: 'hard', reason: 'should not happen' };
        },
      },
    });
    const r = await ladder.gate(cleanCtx());
    expect(r.mode).toBe('execute');
    expect(consumeCalls).toBe(0);
  });
});

const PRINCIPAL: GatePrincipal = {
  sub: '22222222-2222-2222-2222-222222222222',
  scopes: [],
  ctx: { tenantId: '11111111-1111-1111-1111-111111111111' },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ActionTrustLadder.gate — feature flag off', () => {
  it('returns execute deterministically without touching the DB', async () => {
    const { pool } = makePool([]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => false });
    const decision = await ladder.gate(makeCtx());
    expect(decision).toEqual({ mode: 'execute' });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('ActionTrustLadder.gate — platform-default matrix', () => {
  function setup() {
    return makePool([
      { match: 'SELECT current_mode', rows: [] }, // no explicit state row
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'proposal-abc' }] },
    ]);
  }

  it('young tenant + write.external_api.nonprod → dry_run', async () => {
    const { pool } = setup();
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(0, 0, 'write.external_api.nonprod'),
    }));
    expect(decision).toEqual({ mode: 'dry_run', proposalId: 'proposal-abc' });
  });

  it('young-with-signal (age >= 7, score >= 0.6) + write.external_api.nonprod → shadow', async () => {
    const { pool } = setup();
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(10, 0.7, 'write.external_api.nonprod'),
    }));
    expect(decision).toEqual({ mode: 'shadow', shadowId: 'proposal-abc' });
  });

  it('established (age >= 30, score >= 0.85) + write.external_api.nonprod → execute', async () => {
    const { pool } = makePool([
      { match: 'SELECT current_mode', rows: [] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(60, 0.9, 'write.external_api.nonprod'),
    }));
    expect(decision).toEqual({ mode: 'execute' });
  });

  it('established tenant + financial.payment → require_approval (always)', async () => {
    const { pool } = makePool([
      { match: 'SELECT current_mode', rows: [] },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'proposal-fin' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'financial.payment',
      calibrationSnapshot: makeSnapshot(365, 1.0, 'financial.payment'),
    }));
    expect(decision).toEqual({ mode: 'require_approval', approvalId: 'proposal-fin' });
  });

  it('established tenant + read.local → execute (no DB write)', async () => {
    const { pool, calls } = makePool([
      { match: 'SELECT current_mode', rows: [] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'read.local',
      calibrationSnapshot: makeSnapshot(60, 1.0, 'read.local'),
    }));
    expect(decision).toEqual({ mode: 'execute' });
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO oweibo.action_proposals'));
    expect(inserts.length).toBe(0);
  });

  it('young tenant + unclassified → require_approval', async () => {
    const { pool } = makePool([
      { match: 'SELECT current_mode', rows: [] },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'proposal-unc' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'unclassified',
      calibrationSnapshot: makeSnapshot(0, 0, 'unclassified'),
    }));
    expect(decision).toEqual({ mode: 'require_approval', approvalId: 'proposal-unc' });
  });
});

describe('ActionTrustLadder.gate — shadow-only mode', () => {
  it('writes proposal but returns execute', async () => {
    const { pool, calls } = makePool([
      { match: 'SELECT current_mode', rows: [] },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'proposal-shadow' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, {
      isEnabled: () => true,
      isShadowOnly: () => true,
    });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(0, 0, 'write.external_api.nonprod'),
    }));
    expect(decision).toEqual({ mode: 'execute' });
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.action_proposals'))).toBe(true);
  });
});

describe('ActionTrustLadder.gate — explicit state precedence', () => {
  it('explicit state row overrides the matrix', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'execute', pinned_by: 'admin@x', observations: 5, successes: 5 }],
      },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    // Young tenant + financial → matrix says require_approval, but explicit row says execute.
    const decision = await ladder.gate(makeCtx({
      actionClass: 'financial.payment',
      calibrationSnapshot: makeSnapshot(0, 0, 'financial.payment'),
    }));
    expect(decision).toEqual({ mode: 'execute' });
  });

  it('explicit forbidden → forbidden', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'forbidden', pinned_by: 'admin', observations: 0, successes: 0 }],
      },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx());
    expect(decision.mode).toBe('forbidden');
  });
});

describe('ActionTrustLadder.gate — auto-promotion', () => {
  it('auto-promotes when all four conditions hold', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'dry_run', pinned_by: null, observations: 12, successes: 12 }],
      },
      { match: 'UPDATE oweibo.tenant_action_class_state', rows: [] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(15, 0.5, 'write.external_api.nonprod'),
    }));
    expect(decision).toEqual({ mode: 'execute' });
    expect(calls.some((c) =>
      c.sql.includes('UPDATE oweibo.tenant_action_class_state') &&
      c.sql.includes("current_mode = 'execute'"),
    )).toBe(true);
  });

  it('does not auto-promote when pinned', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'dry_run', pinned_by: 'admin', observations: 50, successes: 50 }],
      },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'p1' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(60, 1, 'write.external_api.nonprod'),
    }));
    expect(decision.mode).toBe('dry_run');
  });

  it('does not auto-promote when success rate < 0.95', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'dry_run', pinned_by: null, observations: 20, successes: 18 }],
      },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'p1' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(30, 1, 'write.external_api.nonprod'),
    }));
    expect(decision.mode).toBe('dry_run');
  });

  it('does not auto-promote when observations < 10', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'dry_run', pinned_by: null, observations: 5, successes: 5 }],
      },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'p1' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(30, 1, 'write.external_api.nonprod'),
    }));
    expect(decision.mode).toBe('dry_run');
  });

  it('does not auto-promote when accountAgeDays < 7', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'dry_run', pinned_by: null, observations: 50, successes: 50 }],
      },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'p1' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'write.external_api.nonprod',
      calibrationSnapshot: makeSnapshot(3, 1, 'write.external_api.nonprod'),
    }));
    expect(decision.mode).toBe('dry_run');
  });

  it('never auto-promotes always-require-approval classes', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT current_mode',
        rows: [{ current_mode: 'dry_run', pinned_by: null, observations: 100, successes: 100 }],
      },
      { match: 'INSERT INTO oweibo.action_proposals', rows: [{ id: 'p1' }] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    const decision = await ladder.gate(makeCtx({
      actionClass: 'financial.payment',
      calibrationSnapshot: makeSnapshot(365, 1, 'financial.payment'),
    }));
    expect(decision.mode).toBe('dry_run');
  });
});

describe('ActionTrustLadder.promote', () => {
  it('marks state executed_live on success and bumps observations', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT tenant_id, action_class, mode, state',
        rows: [{ tenant_id: 'aaaa', action_class: 'write.external_api.nonprod', mode: 'dry_run', state: 'pending' }],
      },
      { match: 'UPDATE oweibo.action_proposals', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_action_class_state', rows: [] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    await ladder.promote('proposal-1', PRINCIPAL, 'success');
    expect(calls.some((c) =>
      c.sql.includes('UPDATE oweibo.action_proposals') && c.params.includes('executed_live'),
    )).toBe(true);
    expect(calls.some((c) =>
      c.sql.includes('INSERT INTO oweibo.tenant_action_class_state'),
    )).toBe(true);
  });

  it('rejects double-promotion (state != pending)', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT tenant_id, action_class, mode, state',
        rows: [{ tenant_id: 'aaaa', action_class: 'x', mode: 'dry_run', state: 'executed_live' }],
      },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    await expect(ladder.promote('proposal-1', PRINCIPAL, 'success')).rejects.toThrow(/already executed_live/);
  });
});

describe('ActionTrustLadder.reject', () => {
  it('marks state rejected and bumps rejection counter', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT tenant_id, action_class, state',
        rows: [{ tenant_id: 'aaaa', action_class: 'write.external_api.nonprod', state: 'pending' }],
      },
      { match: 'UPDATE oweibo.action_proposals', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_action_class_state', rows: [] },
    ]);
    const ladder = new ActionTrustLadder(pool, { isEnabled: () => true });
    await ladder.reject('proposal-1', PRINCIPAL, 'not safe enough');
    expect(calls.some((c) =>
      c.sql.includes('UPDATE oweibo.action_proposals') &&
      c.params.includes('not safe enough'),
    )).toBe(true);
  });
});
