/**
 * withTenantScope — single source of truth tests.
 *
 * Validates the F.5-audit invariants:
 *   - BEGIN/COMMIT around the body
 *   - SET LOCAL app.tenant_id when tenantId is a UUID
 *   - SET LOCAL ROLE platform_admin always
 *   - ROLLBACK on body throw
 *   - tenantId === null skips the GUC but still sets the role (cross-tenant ops)
 *   - non-UUID tenantId rejected with a clear error
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withTenantScope } from '../withTenantScope.js';

function fakePool(): { pool: Pool; calls: string[]; released: boolean } {
  const calls: string[] = [];
  let released = false;
  const client: Partial<PoolClient> = {
    query: ((sql: string): Promise<QueryResult> => {
      calls.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn().mockImplementation(() => { released = true; }),
  };
  const pool: Partial<Pool> = {
    connect: jest.fn().mockResolvedValue(client),
  };
  return {
    pool: pool as Pool,
    calls,
    get released() { return released; },
  } as never;
}

describe('withTenantScope', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('wraps the body in BEGIN/COMMIT and sets both GUC + role', async () => {
    const state = fakePool();
    const out = await withTenantScope(state.pool, tenantId, async () => 'ok');
    expect(out).toBe('ok');
    expect(state.calls).toEqual([
      'BEGIN',
      `SET LOCAL app.tenant_id = '${tenantId}'`,
      'SET LOCAL ROLE platform_admin',
      'COMMIT',
    ]);
  });

  it('null tenantId skips the GUC but still sets platform_admin (cross-tenant)', async () => {
    const state = fakePool();
    await withTenantScope(state.pool, null, async () => undefined);
    expect(state.calls).toEqual([
      'BEGIN',
      'SET LOCAL ROLE platform_admin',
      'COMMIT',
    ]);
  });

  it('rolls back on body throw and rethrows', async () => {
    const state = fakePool();
    await expect(withTenantScope(state.pool, tenantId, async () => {
      throw new Error('downstream blew up');
    })).rejects.toThrow(/downstream blew up/);
    expect(state.calls).toEqual([
      'BEGIN',
      `SET LOCAL app.tenant_id = '${tenantId}'`,
      'SET LOCAL ROLE platform_admin',
      'ROLLBACK',
    ]);
  });

  it('releases the client even on body throw', async () => {
    const state = fakePool();
    await expect(withTenantScope(state.pool, tenantId, async () => {
      throw new Error('x');
    })).rejects.toThrow();
    expect(state.released).toBe(true);
  });

  it('rejects non-UUID tenantId before opening a connection', async () => {
    const state = fakePool();
    await expect(withTenantScope(state.pool, 'not-a-uuid', async () => undefined))
      .rejects.toThrow(/invalid tenant id format/);
    expect(state.calls).toEqual([]); // never reached BEGIN
  });

  it('rejects sql-injection-y tenantId before opening a connection', async () => {
    const state = fakePool();
    await expect(withTenantScope(state.pool, "1' OR 1=1; --", async () => undefined))
      .rejects.toThrow(/invalid tenant id format/);
    expect(state.calls).toEqual([]);
  });
});
