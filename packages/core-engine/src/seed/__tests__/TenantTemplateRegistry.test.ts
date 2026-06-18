/**
 * T.6 — TenantTemplateRegistry tests.
 */
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { TenantTemplateRegistry } from '../TenantTemplateRegistry.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: number } {
  const counter = { n: 0 };
  const pool = {
    query: jest.fn().mockImplementation((sql: string): Promise<QueryResult<QueryResultRow>> => {
      counter.n += 1;
      const stub = stubs.find((s) => sql.includes(s.match));
      return Promise.resolve({
        rows: stub ? stub.rows : [],
        rowCount: stub ? stub.rows.length : 0,
        command: '', oid: 0, fields: [],
      });
    }),
  } as unknown as Pool;
  return { pool, get calls() { return counter.n; } };
}

function row(slug: string, overrides: Partial<{
  display_name: string; description: string; industries: string[] | null;
  default_features: unknown; default_quotas: unknown;
  seed_memory_tags: string[] | null; seed_skill_set: string;
  goal_template_set: string; active: boolean;
}> = {}): QueryResultRow {
  return {
    slug,
    display_name: overrides.display_name ?? slug,
    description: overrides.description ?? 'desc',
    industries: overrides.industries ?? [],
    default_features: overrides.default_features ?? {},
    default_quotas: overrides.default_quotas ?? {},
    seed_memory_tags: overrides.seed_memory_tags ?? [],
    seed_skill_set: overrides.seed_skill_set ?? 'platform-default',
    goal_template_set: overrides.goal_template_set ?? 'platform-default',
    active: overrides.active ?? true,
  };
}

describe('TenantTemplateRegistry.list', () => {
  it('returns the rows from the DB mapped to TenantTemplate', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_templates', rows: [row('default'), row('fintech-smb')] },
    ]);
    const reg = new TenantTemplateRegistry(pool);
    const out = await reg.list();
    expect(out.map((t) => t.slug)).toEqual(['default', 'fintech-smb']);
    expect(out[0]?.active).toBe(true);
  });

  it('coalesces null array columns to empty arrays', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_templates',
        rows: [row('default', { industries: null, seed_memory_tags: null })],
      },
    ]);
    const reg = new TenantTemplateRegistry(pool);
    const out = await reg.list();
    expect(out[0]?.industries).toEqual([]);
    expect(out[0]?.seedMemoryTags).toEqual([]);
  });

  it('caches within TTL — repeated list() does NOT re-query', async () => {
    const stubs = [{ match: 'FROM oweibo.tenant_templates', rows: [row('default')] }];
    const recorder = makePool(stubs);
    const reg = new TenantTemplateRegistry(recorder.pool, { cacheTtlMs: 1000, now: () => 0 });
    await reg.list();
    await reg.list();
    await reg.list();
    expect(recorder.calls).toBe(1);
  });

  it('re-queries after TTL expiry', async () => {
    const stubs = [{ match: 'FROM oweibo.tenant_templates', rows: [row('default')] }];
    const recorder = makePool(stubs);
    let t = 0;
    const reg = new TenantTemplateRegistry(recorder.pool, { cacheTtlMs: 100, now: () => t });
    t = 0;
    await reg.list();
    t = 200; // past TTL
    await reg.list();
    expect(recorder.calls).toBe(2);
  });

  it('invalidate() drops the cache', async () => {
    const stubs = [{ match: 'FROM oweibo.tenant_templates', rows: [row('default')] }];
    const recorder = makePool(stubs);
    const reg = new TenantTemplateRegistry(recorder.pool, { cacheTtlMs: 100_000, now: () => 0 });
    await reg.list();
    reg.invalidate();
    await reg.list();
    expect(recorder.calls).toBe(2);
  });
});

describe('TenantTemplateRegistry.get', () => {
  it('returns the template for a known slug', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_templates', rows: [row('default'), row('fintech-smb')] },
    ]);
    const reg = new TenantTemplateRegistry(pool);
    const t = await reg.get('fintech-smb');
    expect(t?.slug).toBe('fintech-smb');
  });

  it('returns null for an unknown slug', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_templates', rows: [row('default')] },
    ]);
    const reg = new TenantTemplateRegistry(pool);
    expect(await reg.get('nonexistent')).toBeNull();
  });
});
