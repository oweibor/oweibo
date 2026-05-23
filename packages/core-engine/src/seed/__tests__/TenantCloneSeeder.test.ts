/**
 * T.9 — TenantCloneSeeder unit tests.
 */
import {
  TenantCloneSeeder,
  validateCloneRequest,
  type CloneInfra,
  type CloneScope,
  type CloneAuditRow,
  CLONED_MEMORY_IMPORTANCE_MULTIPLIER,
} from '../TenantCloneSeeder.js';

const PARENT = '11111111-1111-1111-1111-111111111111';
const CHILD  = '22222222-2222-2222-2222-222222222222';

describe('validateCloneRequest', () => {
  it('rejects empty scopes', () => {
    const r = validateCloneRequest({ parentTenantId: PARENT, childTenantId: CHILD, scopes: [] });
    expect(r).toEqual({ ok: false, error: 'empty scope list' });
  });

  it('rejects self-lineage', () => {
    const r = validateCloneRequest({ parentTenantId: PARENT, childTenantId: PARENT, scopes: ['memories'] });
    expect(r).toEqual({ ok: false, error: 'self-lineage not allowed' });
  });

  it('rejects unknown scope', () => {
    const r = validateCloneRequest({
      parentTenantId: PARENT, childTenantId: CHILD,
      scopes: ['memories', 'totally-fake' as CloneScope],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown scope/);
  });

  it('accepts a well-formed request', () => {
    const r = validateCloneRequest({
      parentTenantId: PARENT, childTenantId: CHILD,
      scopes: ['memories', 'projects'],
    });
    expect(r).toEqual({ ok: true });
  });
});

describe('TenantCloneSeeder.clone', () => {
  it('reports skipped for every scope when no infra is wired (default no-op)', async () => {
    const seeder = new TenantCloneSeeder();
    const out = await seeder.clone({
      parentTenantId: PARENT, childTenantId: CHILD,
      scopes: ['memories', 'projects', 'org_graph'],
    });
    expect(out.results.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('invokes the matching infra op per scope and propagates the count', async () => {
    const infra: CloneInfra = {
      copyMemories: jest.fn(async () => 12),
      copyProjects: jest.fn(async () => 3),
    };
    const seeder = new TenantCloneSeeder(infra);
    const out = await seeder.clone({
      parentTenantId: PARENT, childTenantId: CHILD,
      scopes: ['memories', 'projects'],
    });
    expect(out.results).toEqual([
      { scope: 'memories', status: 'ok', copied: 12 },
      { scope: 'projects', status: 'ok', copied: 3 },
    ]);
    expect(infra.copyMemories).toHaveBeenCalledWith(PARENT, CHILD);
    expect(infra.copyProjects).toHaveBeenCalledWith(PARENT, CHILD);
  });

  it('treats a thrown infra op as a per-scope failure (does NOT propagate)', async () => {
    const infra: CloneInfra = {
      copyMemories: async () => { throw new Error('qdrant down'); },
      copyProjects: async () => 5,
    };
    const seeder = new TenantCloneSeeder(infra);
    const out = await seeder.clone({
      parentTenantId: PARENT, childTenantId: CHILD,
      scopes: ['memories', 'projects'],
    });
    expect(out.results[0]).toEqual({ scope: 'memories', status: 'failed', error: 'qdrant down' });
    expect(out.results[1]).toEqual({ scope: 'projects', status: 'ok', copied: 5 });
  });

  it('audits one row per scope with status + count', async () => {
    const audits: CloneAuditRow[] = [];
    const infra: CloneInfra = {
      copyMemories: async () => 7,
      audit: async (row) => { audits.push(row); },
    };
    const seeder = new TenantCloneSeeder(infra);
    await seeder.clone({ parentTenantId: PARENT, childTenantId: CHILD, scopes: ['memories'] });
    await new Promise((r) => setImmediate(r));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('tenant.lineage.clone.memories');
    expect(audits[0]?.details.copied).toBe(7);
    expect(audits[0]?.details.status).toBe('ok');
  });

  it('continues cloning remaining scopes after one fails', async () => {
    const infra: CloneInfra = {
      copyMemories: async () => { throw new Error('boom'); },
      copyOrgGraph: async () => 4,
    };
    const seeder = new TenantCloneSeeder(infra);
    const out = await seeder.clone({
      parentTenantId: PARENT, childTenantId: CHILD,
      scopes: ['memories', 'org_graph'],
    });
    expect(out.results.map((r) => r.status)).toEqual(['failed', 'ok']);
  });
});

describe('CLONED_MEMORY_IMPORTANCE_MULTIPLIER', () => {
  it('is strictly less than 1 so child organic memories outrank clones', () => {
    expect(CLONED_MEMORY_IMPORTANCE_MULTIPLIER).toBeGreaterThan(0);
    expect(CLONED_MEMORY_IMPORTANCE_MULTIPLIER).toBeLessThan(1);
  });
});
