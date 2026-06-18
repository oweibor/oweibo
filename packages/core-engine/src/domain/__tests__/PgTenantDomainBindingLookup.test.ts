/**
 * Unit tests for PgTenantDomainBindingLookup.
 *
 * Verifies the ORDER BY clause (primary first, weight DESC), tenant scoping,
 * empty-tenant short-circuit, 60s caching, invalidation, and DB error
 * propagation.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { DomainSlug } from '@oweibo/core-contracts';
import { PgTenantDomainBindingLookup } from '../PgTenantDomainBindingLookup.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

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

describe('PgTenantDomainBindingLookup.forTenant', () => {
  it('returns [] when tenantId is malformed (no DB call)', async () => {
    const { pool, calls } = makePool([]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    expect(await lookup.forTenant('not-a-uuid')).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('returns [] when no bindings exist', async () => {
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    expect(await lookup.forTenant(TENANT_A)).toEqual([]);
  });

  it('returns the slugs in the row order the DB returned them', async () => {
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_domain_binding',
      rows: [
        { domain_slug: 'fintech'    },
        { domain_slug: 'healthcare' },
      ],
    }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    const r = await lookup.forTenant(TENANT_A) as readonly DomainSlug[];
    expect(r).toEqual(['fintech', 'healthcare']);
  });

  it('issues an ORDER BY that puts primary before secondary, weight DESC', async () => {
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    await lookup.forTenant(TENANT_A);
    const sql = calls.find(c => c.sql.includes('FROM oweibo.tenant_domain_binding'))!.sql;
    expect(sql).toMatch(/role\s+WHEN\s+'primary'\s+THEN\s+0/);
    expect(sql).toMatch(/weight\s+DESC/);
    expect(sql).toMatch(/domain_slug\s+ASC/);
  });

  it('runs the query inside a tenant-scoped transaction', async () => {
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    await lookup.forTenant(TENANT_A);
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT_A}'`))).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });

  it('caches results within TTL — second forTenant does not re-query', async () => {
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool, { cacheTtlMs: 60_000, now: () => 0 });
    await lookup.forTenant(TENANT_A);
    const firstCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    await lookup.forTenant(TENANT_A);
    const secondCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    expect(secondCount).toBe(firstCount);
  });

  it('expires cache after the TTL elapses', async () => {
    let t = 0;
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool, { cacheTtlMs: 100, now: () => t });
    await lookup.forTenant(TENANT_A);
    t = 200;
    await lookup.forTenant(TENANT_A);
    const count = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    expect(count).toBe(2);
  });

  it('caches per-tenant — separate tenants do not collide', async () => {
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    await lookup.forTenant(TENANT_A);
    await lookup.forTenant(TENANT_B);
    const count = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    expect(count).toBe(2);
    // Re-fetch tenant A — still cached.
    await lookup.forTenant(TENANT_A);
    const after = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    expect(after).toBe(2);
  });

  it('propagates DB errors and rolls back', async () => {
    const err = new Error('boom');
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_domain_binding', rows: [], throws: err },
    ]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    await expect(lookup.forTenant(TENANT_A)).rejects.toThrow(/boom/);
    expect(calls.some(c => c.sql === 'ROLLBACK')).toBe(true);
  });
});

describe('PgTenantDomainBindingLookup.invalidate', () => {
  it('forces a re-query on next forTenant', async () => {
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    await lookup.forTenant(TENANT_A);
    lookup.invalidate(TENANT_A);
    await lookup.forTenant(TENANT_A);
    const count = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    expect(count).toBe(2);
  });

  it('invalidateAll() drops every cached tenant', async () => {
    const { pool, calls } = makePool([{ match: 'FROM oweibo.tenant_domain_binding', rows: [] }]);
    const lookup = new PgTenantDomainBindingLookup(pool);
    await lookup.forTenant(TENANT_A);
    await lookup.forTenant(TENANT_B);
    lookup.invalidateAll();
    await lookup.forTenant(TENANT_A);
    await lookup.forTenant(TENANT_B);
    const count = calls.filter(c => c.sql.includes('FROM oweibo.tenant_domain_binding')).length;
    expect(count).toBe(4);
  });
});
