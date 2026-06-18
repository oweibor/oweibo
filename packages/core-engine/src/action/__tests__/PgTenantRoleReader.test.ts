/**
 * Unit tests for PgTenantRoleReader.
 *
 * Verifies the tenant_memberships role-intersection query, tenant scoping,
 * empty-input guards, and DB error propagation.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PgTenantRoleReader } from '../PgTenantRoleReader.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER_1 = 'ffffffff-ffff-ffff-ffff-ffffffff0001';
const USER_2 = 'ffffffff-ffff-ffff-ffff-ffffffff0002';

interface QueryStub { match: string; rows: Record<string, unknown>[]; throws?: Error; }

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
      rows: stub ? stub.rows : [], rowCount: stub ? stub.rows.length : 0,
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

describe('PgTenantRoleReader.usersWithRoles', () => {
  it('returns [] when tenantId is malformed (no DB call)', async () => {
    const { pool, calls } = makePool([]);
    const r = new PgTenantRoleReader(pool);
    expect(await r.usersWithRoles('not-a-uuid', ['tenant_admin'])).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('returns [] when roles is empty (no DB call)', async () => {
    const { pool, calls } = makePool([]);
    const r = new PgTenantRoleReader(pool);
    expect(await r.usersWithRoles(TENANT, [])).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('returns distinct user_ids whose roles intersect the requested set', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_memberships',
        rows: [{ user_id: USER_1 }, { user_id: USER_2 }],
      },
    ]);
    const r = new PgTenantRoleReader(pool);
    const result = await r.usersWithRoles(TENANT, ['tenant_admin', 'tenant_billing']);
    expect([...result].sort()).toEqual([USER_1, USER_2].sort());
  });

  it('returns empty when no membership rows match', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_memberships', rows: [] },
    ]);
    const r = new PgTenantRoleReader(pool);
    expect(await r.usersWithRoles(TENANT, ['tenant_admin'])).toEqual([]);
  });

  it('uses SELECT DISTINCT user_id with roles && $2::text[] role intersection', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_memberships', rows: [] },
    ]);
    const r = new PgTenantRoleReader(pool);
    await r.usersWithRoles(TENANT, ['tenant_admin']);
    const select = calls.find(c => c.sql.includes('FROM oweibo.tenant_memberships'))!;
    expect(select.sql).toMatch(/SELECT DISTINCT user_id/);
    expect(select.sql).toMatch(/roles\s*&&\s*\$2::text\[\]/);
    expect(select.params).toEqual([TENANT, ['tenant_admin']]);
  });

  it('runs inside a tenant-scoped transaction', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_memberships', rows: [] },
    ]);
    const r = new PgTenantRoleReader(pool);
    await r.usersWithRoles(TENANT, ['tenant_admin']);
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT}'`))).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });

  it('rolls the transaction back on DB error', async () => {
    const err = new Error('boom');
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_memberships', rows: [], throws: err },
    ]);
    const r = new PgTenantRoleReader(pool);
    await expect(r.usersWithRoles(TENANT, ['tenant_admin'])).rejects.toThrow(/boom/);
    expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true);
  });
});
