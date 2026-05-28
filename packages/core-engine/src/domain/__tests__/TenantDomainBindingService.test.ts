/**
 * D.6 — TenantDomainBindingService tests.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  TenantDomainBindingService,
  normaliseBindings,
} from '../TenantDomainBindingService.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const matching = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length);
    const stub = matching[0];
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
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('normaliseBindings (pure helper)', () => {
  it('normalises raw weights to sum to 1.0 and surfaces rawWeight unchanged', () => {
    const rows = [
      { tenant_id: TENANT, domain_slug: 'fintech', role: 'primary' as const, weight: '0.6', bound_by_type: 'classifier' as const, bound_by_id: 'x', confidence: null, bound_at: new Date('2026-05-28T00:00:00Z') },
      { tenant_id: TENANT, domain_slug: 'healthcare', role: 'secondary' as const, weight: '0.3', bound_by_type: 'admin' as const, bound_by_id: 'admin-1', confidence: null, bound_at: new Date('2026-05-28T00:00:00Z') },
    ];
    const out = normaliseBindings(rows);
    expect(out).toHaveLength(2);
    // Normalised: 0.6/0.9 ≈ 0.667, 0.3/0.9 ≈ 0.333
    expect(out[0]!.weight).toBe(0.667);
    expect(out[1]!.weight).toBe(0.333);
    expect(out[0]!.rawWeight).toBe(0.6);
    expect(out[1]!.rawWeight).toBe(0.3);
  });

  it('handles a single binding (normalised weight = 1.0)', () => {
    const rows = [
      { tenant_id: TENANT, domain_slug: 'fintech', role: 'primary' as const, weight: '0.5', bound_by_type: 'classifier' as const, bound_by_id: 'x', confidence: null, bound_at: new Date('2026-05-28T00:00:00Z') },
    ];
    const out = normaliseBindings(rows);
    expect(out[0]!.weight).toBe(1.0);
    expect(out[0]!.rawWeight).toBe(0.5);
  });

  it('handles zero-sum (all weights 0) by returning 0 normalised', () => {
    const rows = [
      { tenant_id: TENANT, domain_slug: 'fintech', role: 'primary' as const, weight: '0', bound_by_type: 'admin' as const, bound_by_id: 'x', confidence: null, bound_at: new Date('2026-05-28T00:00:00Z') },
    ];
    const out = normaliseBindings(rows);
    expect(out[0]!.weight).toBe(0);
  });
});

describe('TenantDomainBindingService.replaceBindings — validation', () => {
  it('rejects more than one primary binding', async () => {
    const { pool } = makePool([]);
    const svc = new TenantDomainBindingService(pool);
    await expect(
      svc.replaceBindings({
        tenantId: TENANT,
        bindings: [
          { domainSlug: 'fintech', role: 'primary', rawWeight: 0.6, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'healthcare', role: 'primary', rawWeight: 0.4, boundBy: { type: 'admin', id: 'a' } },
        ],
      }),
    ).rejects.toThrow(/more than one primary/);
  });

  it('rejects out-of-range weights', async () => {
    const { pool } = makePool([]);
    const svc = new TenantDomainBindingService(pool);
    await expect(
      svc.replaceBindings({
        tenantId: TENANT,
        bindings: [
          { domainSlug: 'fintech', role: 'primary', rawWeight: 1.5, boundBy: { type: 'admin', id: 'a' } },
        ],
      }),
    ).rejects.toThrow(/invalid weight/);
  });

  it('rejects duplicate slugs', async () => {
    const { pool } = makePool([]);
    const svc = new TenantDomainBindingService(pool);
    await expect(
      svc.replaceBindings({
        tenantId: TENANT,
        bindings: [
          { domainSlug: 'fintech', role: 'primary', rawWeight: 0.5, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'fintech', role: 'secondary', rawWeight: 0.5, boundBy: { type: 'admin', id: 'a' } },
        ],
      }),
    ).rejects.toThrow(/duplicate slug/);
  });

  it('rejects > soft cap without force', async () => {
    const { pool } = makePool([]);
    const svc = new TenantDomainBindingService(pool);
    await expect(
      svc.replaceBindings({
        tenantId: TENANT,
        bindings: [
          { domainSlug: 'a', role: 'primary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'b', role: 'secondary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'c', role: 'secondary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'd', role: 'secondary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
        ],
      }),
    ).rejects.toThrow(/exceeds soft cap/);
  });

  it('permits > soft cap with force=true', async () => {
    const { pool } = makePool([
      { match: 'DELETE FROM oweibo.tenant_domain_binding', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_domain_binding', rows: [] },
      { match: 'SELECT tenant_id, domain_slug', rows: [] },
    ]);
    const svc = new TenantDomainBindingService(pool);
    await expect(
      svc.replaceBindings({
        tenantId: TENANT,
        force: true,
        bindings: [
          { domainSlug: 'a', role: 'primary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'b', role: 'secondary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'c', role: 'secondary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
          { domainSlug: 'd', role: 'secondary', rawWeight: 0.25, boundBy: { type: 'admin', id: 'a' } },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('permits an empty binding set (unbind)', async () => {
    const { pool, calls } = makePool([
      { match: 'DELETE FROM oweibo.tenant_domain_binding', rows: [] },
      { match: 'SELECT tenant_id, domain_slug', rows: [] },
    ]);
    const svc = new TenantDomainBindingService(pool);
    const out = await svc.replaceBindings({ tenantId: TENANT, bindings: [] });
    expect(out).toEqual([]);
    expect(calls.some((c) => c.sql.includes('DELETE FROM oweibo.tenant_domain_binding'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.tenant_domain_binding'))).toBe(false);
  });
});

describe('TenantDomainBindingService.replaceBindings — write path', () => {
  it('deletes existing then inserts each binding row in a transaction', async () => {
    const { pool, calls } = makePool([
      { match: 'DELETE FROM oweibo.tenant_domain_binding', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_domain_binding', rows: [] },
      { match: 'SELECT tenant_id, domain_slug', rows: [] },
    ]);
    const svc = new TenantDomainBindingService(pool);
    await svc.replaceBindings({
      tenantId: TENANT,
      bindings: [
        { domainSlug: 'fintech', role: 'primary', rawWeight: 0.6, boundBy: { type: 'admin', id: 'admin-1' } },
        { domainSlug: 'healthcare', role: 'secondary', rawWeight: 0.4, boundBy: { type: 'admin', id: 'admin-1' } },
      ],
    });
    const inserts = calls.filter((c) =>
      c.sql.includes('INSERT INTO oweibo.tenant_domain_binding'),
    );
    expect(inserts).toHaveLength(2);
    expect(calls.some((c) => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('rolls back on insert failure', async () => {
    const calls: string[] = [];
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      calls.push(sql);
      if (sql.includes('INSERT INTO oweibo.tenant_domain_binding')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = {
      query: jest.fn().mockImplementation(queryFn),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const svc = new TenantDomainBindingService(pool);
    await expect(
      svc.replaceBindings({
        tenantId: TENANT,
        bindings: [
          { domainSlug: 'fintech', role: 'primary', rawWeight: 1, boundBy: { type: 'admin', id: 'a' } },
        ],
      }),
    ).rejects.toThrow(/boom/);
    expect(calls.some((s) => s === 'ROLLBACK')).toBe(true);
  });
});

describe('TenantDomainBindingService — read helpers', () => {
  const ROWS = [
    {
      tenant_id: TENANT,
      domain_slug: 'fintech',
      role: 'primary',
      weight: '0.6',
      bound_by_type: 'classifier',
      bound_by_id: 'ttv-t2g-backfill',
      confidence: '0.85',
      bound_at: new Date('2026-05-28T00:00:00Z'),
    },
    {
      tenant_id: TENANT,
      domain_slug: 'healthcare',
      role: 'secondary',
      weight: '0.4',
      bound_by_type: 'admin',
      bound_by_id: 'admin-1',
      confidence: null,
      bound_at: new Date('2026-05-28T00:00:00Z'),
    },
  ];

  it('listBindings returns normalised + raw weights', async () => {
    const { pool } = makePool([{ match: 'SELECT tenant_id, domain_slug', rows: ROWS }]);
    const svc = new TenantDomainBindingService(pool);
    const out = await svc.listBindings(TENANT);
    expect(out).toHaveLength(2);
    expect(out[0]!.weight + out[1]!.weight).toBeCloseTo(1.0, 3);
  });

  it('primaryDomain returns the primary slug or null', async () => {
    const { pool } = makePool([{ match: 'SELECT tenant_id, domain_slug', rows: ROWS }]);
    const svc = new TenantDomainBindingService(pool);
    expect(await svc.primaryDomain(TENANT)).toBe('fintech');

    const { pool: empty } = makePool([{ match: 'SELECT tenant_id, domain_slug', rows: [] }]);
    const svc2 = new TenantDomainBindingService(empty);
    expect(await svc2.primaryDomain(TENANT)).toBeNull();
  });

  it('lookupForResolver returns slug list matching the D.2/D.3 seam', async () => {
    const { pool } = makePool([{ match: 'SELECT tenant_id, domain_slug', rows: ROWS }]);
    const svc = new TenantDomainBindingService(pool);
    const slugs = await svc.lookupForResolver(TENANT);
    expect(slugs.sort()).toEqual(['fintech', 'healthcare']);
  });
});
