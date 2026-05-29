/**
 * Unit tests for PostgresRowCountVerifier.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { DeferredVerifierInput } from '@oweibo/core-contracts';
import { PostgresRowCountVerifier } from '../PostgresRowCountVerifier.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface QueryStub { match: string; rows?: Record<string, unknown>[]; throws?: Error; }

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
      rows: stub?.rows ?? [], rowCount: stub?.rows?.length ?? 0,
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

function deferred(verifierConfig: unknown): DeferredVerifierInput {
  return { tenantId: TENANT, proposalId: 'p-1', verifierConfig, expected: null };
}

const goodCfg = {
  countSql: 'SELECT COUNT(*) AS count FROM oweibo.things WHERE status = $1',
  params: ['active'],
  expected: 10,
};

describe('PostgresRowCountVerifier', () => {
  it('appliesTo write.tenant_db.* classes', () => {
    const { pool } = makePool([]);
    const v = new PostgresRowCountVerifier(pool);
    expect(v.appliesTo('write.tenant_db.users')).toBe(true);
    expect(v.appliesTo('write.tenant_db.orders.upsert')).toBe(true);
    expect(v.appliesTo('deploy.prod')).toBe(false);
  });

  it('returns severity 2 when config is missing', async () => {
    const { pool } = makePool([]);
    const v = new PostgresRowCountVerifier(pool);
    expect((await v.deferred(deferred(null))).severity).toBe(2);
  });

  it('returns severity 3 on malformed tenantId', async () => {
    const { pool } = makePool([]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred({ tenantId: 'bad', proposalId: 'p-1', verifierConfig: goodCfg, expected: null });
    expect(r.severity).toBe(3);
    expect(r.notes).toMatch(/tenantId/);
  });

  it('returns severity 3 when countSql does not begin with SELECT', async () => {
    const { pool } = makePool([]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred({ ...goodCfg, countSql: 'DELETE FROM oweibo.things' }));
    expect(r.severity).toBe(3);
    expect(r.notes).toMatch(/begin with SELECT/);
  });

  it('returns severity 0 on exact match', async () => {
    const { pool } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: '10' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(0);
    expect(r.observed).toBe(10);
  });

  it('returns severity 1 within tolerance', async () => {
    const { pool } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: '11' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred({ ...goodCfg, tolerance: 1 }));
    expect(r.severity).toBe(1);
  });

  it('returns severity 2 within 5% of expected', async () => {
    const { pool } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: '104' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred({ ...goodCfg, expected: 100 }));
    expect(r.severity).toBe(2);
  });

  it('returns severity 3 on larger drift', async () => {
    const { pool } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: '500' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred({ ...goodCfg, expected: 10 }));
    expect(r.severity).toBe(3);
  });

  it('returns severity 3 on DB error', async () => {
    const { pool } = makePool([{ match: 'SELECT COUNT(*)', throws: new Error('boom') }]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(3);
    expect(r.notes).toMatch(/boom/);
  });

  it('returns severity 3 when count is non-numeric', async () => {
    const { pool } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: 'NaN-ish' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(3);
  });

  it('runs inside a tenant-scoped transaction', async () => {
    const { pool, calls } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: '10' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    await v.deferred(deferred(goodCfg));
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT}'`))).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });

  it('passes plan.params through to client.query', async () => {
    const { pool, calls } = makePool([{ match: 'SELECT COUNT(*)', rows: [{ count: '10' }] }]);
    const v = new PostgresRowCountVerifier(pool);
    await v.deferred(deferred(goodCfg));
    const sel = calls.find(c => c.sql.includes('SELECT COUNT(*)'))!;
    expect(sel.params).toEqual(['active']);
  });
});
