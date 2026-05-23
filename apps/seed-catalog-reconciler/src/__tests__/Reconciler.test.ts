/**
 * T.7 — SeedCatalogReconciler tests.
 *
 * Most coverage is on the classify() pure function — diff classification
 * is the load-bearing logic. The runOnce() integration is exercised
 * lightly through a mock pool to verify the gate + tx wiring.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  SeedCatalogReconciler,
  classify,
  type CatalogEntry,
  type InstallLogRow,
} from '../Reconciler.js';

function entry(seedId: string, contentHash: string, version = '1'): CatalogEntry {
  return { seedId, catalogVersion: version, contentHash, preview: { seedId, version } };
}

function install(seedId: string, contentHash: string, version = '1', retiredAt: Date | null = null): InstallLogRow {
  return { tenantId: 't', seedId, catalogVersion: version, contentHash, retiredAt };
}

describe('classify', () => {
  it('returns no diffs when catalog matches install log exactly', () => {
    const catalog = [entry('s1', 'h1'), entry('s2', 'h2')];
    const installs = [install('s1', 'h1'), install('s2', 'h2')];
    const out = classify('t', catalog, new Map(catalog.map((c) => [c.seedId, c])), installs);
    expect(out).toEqual([]);
  });

  it('classifies a new seed as additive', () => {
    const catalog = [entry('s1', 'h1')];
    const out = classify('t', catalog, new Map([['s1', catalog[0]!]]), []);
    expect(out).toHaveLength(1);
    expect(out[0]?.changeKind).toBe('additive');
    expect(out[0]?.toContentHash).toBe('h1');
    expect(out[0]?.fromContentHash).toBeNull();
  });

  it('classifies content_hash mismatch as revision (catalog version irrelevant)', () => {
    // Same catalogVersion '1', different content_hash → revision.
    const catalog = [entry('s1', 'h-NEW', '1')];
    const installs = [install('s1', 'h-OLD', '1')];
    const out = classify('t', catalog, new Map([['s1', catalog[0]!]]), installs);
    expect(out).toHaveLength(1);
    expect(out[0]?.changeKind).toBe('revision');
    expect(out[0]?.fromContentHash).toBe('h-OLD');
    expect(out[0]?.toContentHash).toBe('h-NEW');
  });

  it('does NOT flag a revision when version string changes but content_hash matches', () => {
    const catalog = [entry('s1', 'h1', '2')];
    const installs = [install('s1', 'h1', '1')]; // same hash, different version
    const out = classify('t', catalog, new Map([['s1', catalog[0]!]]), installs);
    expect(out).toEqual([]);
  });

  it('classifies a removed seed (in install log, absent from catalog) as removal', () => {
    const catalog: CatalogEntry[] = [];
    const installs = [install('gone', 'h-gone')];
    const out = classify('t', catalog, new Map(), installs);
    expect(out).toHaveLength(1);
    expect(out[0]?.changeKind).toBe('removal');
    expect(out[0]?.seedId).toBe('gone');
  });

  it('treats a re-introduced previously-retired seed as additive', () => {
    const catalog = [entry('s1', 'h1')];
    const installs = [{ ...install('s1', 'h1'), retiredAt: new Date('2026-01-01T00:00:00Z') }];
    const out = classify('t', catalog, new Map([['s1', catalog[0]!]]), installs);
    expect(out).toHaveLength(1);
    expect(out[0]?.changeKind).toBe('additive');
  });

  it('skips already-retired seeds when computing removal (they were already tombstoned)', () => {
    const catalog: CatalogEntry[] = [];
    const installs = [{ ...install('s1', 'h1'), retiredAt: new Date('2026-01-01T00:00:00Z') }];
    const out = classify('t', catalog, new Map(), installs);
    expect(out).toEqual([]);
  });

  it('produces one diff per affected seed regardless of catalog size', () => {
    const catalog = [
      entry('s1', 'h1'),  // unchanged
      entry('s2', 'NEW'), // revision
      entry('s3', 'h3'),  // additive
    ];
    const installs = [
      install('s1', 'h1'),
      install('s2', 'OLD'),
      install('s_old', 'gone'), // removal
    ];
    const out = classify('t', catalog, new Map(catalog.map((c) => [c.seedId, c])), installs);
    expect(out.map((d) => `${d.seedId}:${d.changeKind}`).sort()).toEqual([
      's2:revision',
      's3:additive',
      's_old:removal',
    ]);
  });
});

// ── Light integration: runOnce gate + scan ───────────────────────────────

interface QueryStub {
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
      command: '', oid: 0, fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

const silent = () => undefined;

describe('SeedCatalogReconciler.runOnce', () => {
  it('short-circuits when feature flag is off', async () => {
    const { pool, calls } = makePool([]);
    const recon = new SeedCatalogReconciler(pool, async () => [], { isAllowed: async () => false, log: silent });
    const out = await recon.runOnce();
    expect(out).toEqual({ additiveDetected: 0, revisionsDetected: 0, removalsTombstoned: 0, tenantsScanned: 0 });
    expect(calls).toHaveLength(0);
  });

  it('writes additive pending rows for tenants with no install log', async () => {
    const { pool, calls } = makePool([
      { match: "FROM oweibo.tenants WHERE status = 'active'", rows: [{ id: 'tenant-1' }] },
      { match: 'FROM oweibo.tenant_seed_install_log', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_catalog_pending_updates', rows: [] },
    ]);
    const recon = new SeedCatalogReconciler(
      pool,
      async () => [entry('s1', 'h1')],
      { log: silent },
    );
    const out = await recon.runOnce();
    expect(out.additiveDetected).toBe(1);
    expect(out.tenantsScanned).toBe(1);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_catalog_pending_updates'));
    expect(insert).toBeDefined();
    // Resolution should be null because autoInstallAdditive defaults to false
    expect(insert?.params[10]).toBeNull();
  });

  it('marks additive resolution=installed when autoInstallAdditive=true', async () => {
    const { pool, calls } = makePool([
      { match: "FROM oweibo.tenants WHERE status = 'active'", rows: [{ id: 't1' }] },
      { match: 'FROM oweibo.tenant_seed_install_log', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_catalog_pending_updates', rows: [] },
    ]);
    const recon = new SeedCatalogReconciler(
      pool,
      async () => [entry('s1', 'h1')],
      { autoInstallAdditive: true, log: silent },
    );
    await recon.runOnce();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_catalog_pending_updates'));
    expect(insert?.params[10]).toBe('installed');
  });

  it('tombstones removals via UPDATE on tenant_seed_install_log', async () => {
    const { pool, calls } = makePool([
      { match: "FROM oweibo.tenants WHERE status = 'active'", rows: [{ id: 't1' }] },
      {
        match: 'FROM oweibo.tenant_seed_install_log',
        rows: [{ tenant_id: 't1', seed_id: 'gone', catalog_version: '1', content_hash: 'h-gone', retired_at: null }],
      },
      { match: 'UPDATE oweibo.tenant_seed_install_log', rows: [] },
    ]);
    const recon = new SeedCatalogReconciler(pool, async () => [], { log: silent });
    const out = await recon.runOnce();
    expect(out.removalsTombstoned).toBe(1);
    const upd = calls.find((c) => c.sql.includes('UPDATE oweibo.tenant_seed_install_log'));
    expect(upd?.params[1]).toBe('gone');
  });
});
