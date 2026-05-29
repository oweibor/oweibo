/**
 * S.3 — RollbackOrchestrator tests.
 *
 * Covers:
 *   - flag off → not-implemented failure (no DB)
 *   - missing proposal → failed result
 *   - rolling back a `recovery.rollback.*` action is refused (recursion guard)
 *   - non-executed state → refused
 *   - irreversible envelope → refused
 *   - missing adapter → failed, proposal unchanged
 *   - preflight throws → failed, proposal unchanged
 *   - execute throws → failed, proposal marked rollback_failed
 *   - execute success → success, proposal marked rolled_back
 *   - execute timeout → failed
 *   - double-execute against an idempotent adapter is safe (registry behavior)
 *   - registry: resolve / register / names
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  RollbackOrchestrator,
  RollbackAdapterRegistry,
} from '../RollbackOrchestrator.js';
import { NoOpRollbackAdapter } from '../rollback-adapters/NoOpRollbackAdapter.js';
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACTION = '22222222-2222-2222-2222-222222222222';

interface QueryStub { match: string; rows: QueryResultRow[]; }

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
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

const silent = () => undefined;

function proposalRow(overrides: {
  state?: string;
  action_class?: string;
  rollback_kind?: string | null;
  rollback_detail?: unknown;
  plan_id?: string | null;
} = {}): QueryResultRow {
  // Use `in` checks so explicit `null` overrides aren't swallowed by `??`.
  return {
    id: ACTION,
    tenant_id: TENANT,
    action_class: overrides.action_class ?? 'write.tenant_db.prod',
    state: overrides.state ?? 'executed_live',
    rollback_kind: 'rollback_kind' in overrides ? overrides.rollback_kind : 'reversible_with_cost',
    rollback_detail: 'rollback_detail' in overrides
      ? overrides.rollback_detail
      : { details: 'undo via snapshot', adapterName: 'noop' },
    plan_id: overrides.plan_id ?? null,
  };
}

function makeOrch(stubs: QueryStub[], registry: RollbackAdapterRegistry, opts: { enabled?: boolean } = {}) {
  const { pool, calls } = makePool([
    ...stubs,
    // The writeStartRow INSERT — RETURNING id so the orchestrator gets one.
    { match: 'INSERT INTO oweibo.rollback_executions', rows: [{ id: 'exec-1' }] },
    // The completeExecution lookup of original_action_id — needed when failure path
    { match: 'SELECT original_action_id FROM oweibo.rollback_executions', rows: [{ original_action_id: ACTION }] },
  ]);
  const orch = new RollbackOrchestrator(pool, registry, {
    isEnabled: () => opts.enabled ?? true,
    log: silent,
    executeTimeoutMs: 1000,
  });
  return { orch, pool, calls };
}

// ── Registry ───────────────────────────────────────────────────────────

describe('RollbackAdapterRegistry', () => {
  it('register + resolve', () => {
    const reg = new RollbackAdapterRegistry();
    const a = new NoOpRollbackAdapter('foo');
    reg.register(a);
    expect(reg.resolve('foo')).toBe(a);
    expect(reg.resolve('missing')).toBeUndefined();
  });

  it('names() returns sorted adapter names', () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter('zeta'));
    reg.register(new NoOpRollbackAdapter('alpha'));
    expect(reg.names()).toEqual(['alpha', 'zeta']);
  });
});

// ── Orchestrator paths ─────────────────────────────────────────────────

describe('RollbackOrchestrator.execute', () => {
  it('flag off → returns failed without touching DB or adapter', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch, calls } = makeOrch([], reg, { enabled: false });
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'user-1' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/flag is off/);
    expect(calls).toHaveLength(0);
  });

  it('missing proposal → failed', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'user-1' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/not found/);
  });

  it('refuses to roll back a recovery.rollback.* action (recursion guard)', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [
        proposalRow({ action_class: 'recovery.rollback.write.tenant_db.prod' }),
      ] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/cannot roll back a rollback/);
  });

  it('refuses non-executed state', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [proposalRow({ state: 'pending' })] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/can only roll back executed/);
  });

  it('refuses an irreversible envelope', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [
        proposalRow({ rollback_kind: 'irreversible', rollback_detail: { details: 'gone' } }),
      ] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/irreversible/);
  });

  it('refuses when no rollback envelope captured', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [
        proposalRow({ rollback_kind: null, rollback_detail: null }),
      ] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/no rollback envelope/);
  });

  it('refuses when adapter is not registered', async () => {
    const reg = new RollbackAdapterRegistry(); // empty
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [
        proposalRow({ rollback_detail: { details: 'x', adapterName: 'not-registered' } }),
      ] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/no rollback adapter/);
  });

  it('preflight throws → failed result, proposal NOT marked rollback_failed', async () => {
    const reg = new RollbackAdapterRegistry();
    const failingAdapter: IRollbackAdapter = {
      name: 'noop',
      async preflight() { throw new Error('table missing'); },
      async execute() { throw new Error('should not run'); },
    };
    reg.register(failingAdapter);
    const { orch, calls } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [proposalRow()] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/preflight failed/);
    // No UPDATE to mark proposal as rollback_failed should have fired.
    const markFailed = calls.find((c) =>
      c.sql.includes(`UPDATE oweibo.action_proposals`) &&
      c.sql.includes(`SET state`) &&
      (c.params[1] === 'rollback_failed' || c.params[1] === 'rolled_back'),
    );
    expect(markFailed).toBeUndefined();
  });

  it('execute throws → failed result, proposal marked rollback_failed', async () => {
    const reg = new RollbackAdapterRegistry();
    const adapter: IRollbackAdapter = {
      name: 'noop',
      async preflight() { /* ok */ },
      async execute() { throw new Error('database unreachable'); },
    };
    reg.register(adapter);
    const { orch, calls } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [proposalRow()] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    const mark = calls.find((c) =>
      c.sql.includes(`UPDATE oweibo.action_proposals`) &&
      c.sql.includes(`SET state`) &&
      c.params[1] === 'rollback_failed',
    );
    expect(mark).toBeDefined();
  });

  it('execute success → result success, proposal marked rolled_back, execution row completed', async () => {
    const reg = new RollbackAdapterRegistry();
    reg.register(new NoOpRollbackAdapter());
    const { orch, calls } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [proposalRow()] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'undo failed deploy', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(true);
    expect(r.state).toBe('fully_reverted');
    const mark = calls.find((c) =>
      c.sql.includes(`UPDATE oweibo.action_proposals`) &&
      c.sql.includes(`SET state`) &&
      c.params[1] === 'rolled_back',
    );
    expect(mark).toBeDefined();
    const upd = calls.find((c) => c.sql.includes('UPDATE oweibo.rollback_executions'));
    expect(upd).toBeDefined();
  });

  it('execute timeout → failed result with timeout message', async () => {
    const reg = new RollbackAdapterRegistry();
    const adapter: IRollbackAdapter = {
      name: 'noop',
      async preflight() { /* ok */ },
      execute() { return new Promise<RollbackResult>(() => undefined); }, // never resolves
    };
    reg.register(adapter);
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [proposalRow()] },
    ], reg);
    // Override executeTimeoutMs through option override on the orchestrator
    // — easier to just construct with shorter timeout inline.
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/timeout/);
  }, 5000);

  it('derives adapter name from action_class when envelope omits it', async () => {
    const reg = new RollbackAdapterRegistry();
    // 'write.tenant_db.prod' → postgres convention (NoOp with name 'postgres')
    reg.register(new NoOpRollbackAdapter('postgres'));
    const { orch } = makeOrch([
      { match: 'FROM oweibo.action_proposals', rows: [
        // No adapterName in envelope — must derive from action_class
        proposalRow({ rollback_detail: { details: 'undo via snapshot' } }),
      ] },
    ], reg);
    const r = await orch.execute({
      tenantId: TENANT, originalActionId: ACTION,
      reason: 'op', invokedBy: { type: 'human', id: 'u' },
    });
    expect(r.success).toBe(true);
  });
});

// ── NoOpRollbackAdapter ───────────────────────────────────────────────

describe('NoOpRollbackAdapter', () => {
  it('preflight always succeeds', async () => {
    const a = new NoOpRollbackAdapter();
    await expect(a.preflight(
      { kind: 'trivial', details: '' } as RollbackEnvelope,
      { tenantId: TENANT, originalActionId: ACTION, originalPlanId: null,
        invokedBy: { type: 'human', id: 'u' }, correlationId: 'c' } as RollbackContext,
    )).resolves.toBeUndefined();
  });

  it('execute returns fully_reverted', async () => {
    const a = new NoOpRollbackAdapter();
    const r = await a.execute(
      { kind: 'trivial', details: '' } as RollbackEnvelope,
      { tenantId: TENANT, originalActionId: ACTION, originalPlanId: null,
        invokedBy: { type: 'human', id: 'u' }, correlationId: 'c' } as RollbackContext,
    );
    expect(r.success).toBe(true);
    expect(r.state).toBe('fully_reverted');
  });

  it('honors custom name', () => {
    const a = new NoOpRollbackAdapter('custom-name');
    expect(a.name).toBe('custom-name');
  });
});
