/**
 * Unit tests for PostgresRollbackAdapter.
 *
 * Mocks the Pool — verifies preflight refusals, SET LOCAL app.tenant_id,
 * transaction wrapping, rowCount reporting, expectedRowCount mismatch
 * → 'partial', zero-row no_op_already_reverted path, and error rollback.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { RollbackContext, RollbackEnvelope } from '@oweibo/core-contracts';
import { PostgresRollbackAdapter } from '../PostgresRollbackAdapter.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface QueryStub {
  match: string;
  result?: { rows?: Record<string, unknown>[]; rowCount?: number };
  throws?: Error;
}

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    if (stub?.throws) return Promise.reject(stub.throws);
    return Promise.resolve({
      rows: stub?.result?.rows ?? [],
      rowCount: stub?.result?.rowCount ?? 0,
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

const ctx: RollbackContext = {
  tenantId: TENANT,
  originalActionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  originalPlanId: null,
  invokedBy: { type: 'human', id: 'operator' },
  correlationId: 'corr-1',
};

const goodPlan = {
  reverseSql: 'UPDATE oweibo.things SET status = $1 WHERE id = $2',
  params: ['original', 'thing-1'],
};

describe('PostgresRollbackAdapter.preflight', () => {
  const { pool } = makePool([]);
  const adapter = new PostgresRollbackAdapter(pool);

  it('refuses envelope.kind=irreversible', async () => {
    const env: RollbackEnvelope = { kind: 'irreversible', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/irreversible/);
  });

  it('refuses missing rollbackPlan', async () => {
    const env: RollbackEnvelope = { kind: 'trivial', details: '' };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/missing rollbackPlan/);
  });

  it('refuses empty reverseSql', async () => {
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: { reverseSql: '   ' } };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/reverseSql/);
  });

  it('refuses DROP SCHEMA / GRANT / REVOKE in reverseSql', async () => {
    for (const sql of ['DROP SCHEMA oweibo CASCADE', 'GRANT ALL TO public', 'REVOKE ALL FROM oweibo_app']) {
      const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: { reverseSql: sql } };
      await expect(adapter.preflight(env, ctx)).rejects.toThrow(/schema\/grant ops/);
    }
  });

  it('passes preflight for a well-formed plan', async () => {
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).resolves.toBeUndefined();
  });
});

describe('PostgresRollbackAdapter.execute', () => {
  it('returns failed for malformed tenantId without touching DB', async () => {
    const { pool, calls } = makePool([]);
    const adapter = new PostgresRollbackAdapter(pool);
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    const r = await adapter.execute(env, { ...ctx, tenantId: 'not-a-uuid' });
    expect(r.success).toBe(false);
    expect(r.state).toBe('failed');
    expect(calls.length).toBe(0);
  });

  it('runs reverseSql inside a tenant-scoped transaction', async () => {
    const { pool, calls } = makePool([
      { match: 'UPDATE oweibo.things', result: { rowCount: 1 } },
    ]);
    const adapter = new PostgresRollbackAdapter(pool);
    await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT}'`))).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });

  it('reports rowCount in details + sideEffects', async () => {
    const { pool } = makePool([
      { match: 'UPDATE oweibo.things', result: { rowCount: 3 } },
    ]);
    const adapter = new PostgresRollbackAdapter(pool);
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('fully_reverted');
    expect(r.details).toMatch(/3 row\(s\)/);
    expect(r.sideEffects).toContain('postgres.rows_reverted=3');
  });

  it('returns partial when expectedRowCount disagrees with the SQL result', async () => {
    const { pool } = makePool([
      { match: 'UPDATE oweibo.things', result: { rowCount: 2 } },
    ]);
    const adapter = new PostgresRollbackAdapter(pool);
    const plan = { ...goodPlan, expectedRowCount: 5 };
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: plan }, ctx);
    expect(r.state).toBe('partial');
    expect(r.details).toMatch(/expected 5/);
  });

  it('returns no_op_already_reverted when both expected and actual are 0', async () => {
    const { pool } = makePool([
      { match: 'UPDATE oweibo.things', result: { rowCount: 0 } },
    ]);
    const adapter = new PostgresRollbackAdapter(pool);
    const plan = { ...goodPlan, expectedRowCount: 0 };
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: plan }, ctx);
    expect(r.state).toBe('no_op_already_reverted');
  });

  it('rolls back the transaction on SQL error and returns failed', async () => {
    const err = new Error('column missing');
    const { pool, calls } = makePool([
      { match: 'UPDATE oweibo.things', throws: err },
    ]);
    const adapter = new PostgresRollbackAdapter(pool);
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.success).toBe(false);
    expect(r.state).toBe('failed');
    expect(r.details).toMatch(/column missing/);
    expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('passes plan.params through to client.query', async () => {
    const { pool, calls } = makePool([
      { match: 'UPDATE oweibo.things', result: { rowCount: 1 } },
    ]);
    const adapter = new PostgresRollbackAdapter(pool);
    await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    const updateCall = calls.find(c => c.sql.includes('UPDATE oweibo.things'))!;
    expect(updateCall.params).toEqual(['original', 'thing-1']);
  });
});
