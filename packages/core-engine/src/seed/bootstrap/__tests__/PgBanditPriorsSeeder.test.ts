/**
 * F.5.3 — PgBanditPriorsSeeder tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { OperationalModeService } from '../../../infrastructure/OperationalModeService.js';
import { PgBanditPriorsSeeder } from '../PgBanditPriorsSeeder.js';

interface PriorRow {
  scope_key: string;
  alpha_sum: string;
  beta_sum:  string;
  contributor_count: number;
  catalog_version:   string;
}

function makeModes(allowed: boolean): OperationalModeService {
  return { isAllowed: jest.fn().mockResolvedValue(allowed) } as unknown as OperationalModeService;
}

function makePool(priors: PriorRow[], existingArms = new Set<string>()): {
  pool: Pool;
  queries: { text: string; values?: unknown[] }[];
  } {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client: Partial<PoolClient> = {
    query: ((text: string, values?: unknown[]): Promise<QueryResult> => {
      queries.push({ text, values });
      if (text.includes('INSERT INTO oweibo.tenant_bandit_arms')) {
        const key = `${(values as unknown[])[1]}|${(values as unknown[])[2]}|${(values as unknown[])[3]}`;
        const fresh = !existingArms.has(key);
        if (fresh) existingArms.add(key);
        return Promise.resolve({ rows: [], rowCount: fresh ? 1 : 0, command: 'INSERT', oid: 0, fields: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  const pool: Partial<Pool> = {
    connect: jest.fn().mockResolvedValue(client),
    query: (jest.fn() as Pool['query']).mockResolvedValue({
      rows: priors,
      rowCount: priors.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    }) as Pool['query'],
  };
  return { pool: pool as Pool, queries };
}

describe('PgBanditPriorsSeeder', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('returns mode_too_low when bandit_learning is disabled', async () => {
    const { pool } = makePool([]);
    const seeder = new PgBanditPriorsSeeder(pool, makeModes(false));

    const out = await seeder.seedPriors(tenantId);
    expect(out.reason).toBe('mode_too_low');
    expect(out.armsSeeded).toBe(0);
  });

  it('returns no_priors_available when the table is empty', async () => {
    const { pool } = makePool([]);
    const seeder = new PgBanditPriorsSeeder(pool, makeModes(true));

    const out = await seeder.seedPriors(tenantId);
    expect(out.reason).toBe('no_priors_available');
    expect(out.armsSeeded).toBe(0);
    expect(out.slotsConsidered).toBe(0);
  });

  it('seeds one arm per prior row with parsed slot_id + channel', async () => {
    const { pool, queries } = makePool([
      { scope_key: 'reviewer:plan_review:stable', alpha_sum: '12.5', beta_sum: '3.5', contributor_count: 8, catalog_version: 'v1' },
      { scope_key: 'reviewer:plan_review:fast',   alpha_sum: '9.0',  beta_sum: '5.0', contributor_count: 6, catalog_version: 'v1' },
    ]);
    const seeder = new PgBanditPriorsSeeder(pool, makeModes(true));

    const out = await seeder.seedPriors(tenantId);
    expect(out.reason).toBe('ok');
    expect(out.armsSeeded).toBe(2);
    expect(out.slotsConsidered).toBe(2);

    const inserts = queries.filter((q) => q.text.includes('INSERT INTO oweibo.tenant_bandit_arms'));
    expect(inserts).toHaveLength(2);
    expect((inserts[0]!.values as unknown[])[2]).toBe('plan_review'); // slot_id
    expect((inserts[0]!.values as unknown[])[3]).toBe('stable');      // channel
    expect((inserts[0]!.values as unknown[])[6]).toBe('platform_prior');
  });

  it('idempotent: existing arms are not duplicated', async () => {
    const existing = new Set<string>();
    const { pool } = makePool([
      { scope_key: 'reviewer:plan_review:stable', alpha_sum: '12.5', beta_sum: '3.5', contributor_count: 8, catalog_version: 'v1' },
    ], existing);
    const seeder = new PgBanditPriorsSeeder(pool, makeModes(true));

    const first  = await seeder.seedPriors(tenantId);
    const second = await seeder.seedPriors(tenantId);

    expect(first.armsSeeded).toBe(1);
    expect(second.armsSeeded).toBe(0);
    expect(second.slotsConsidered).toBe(1);
    expect(second.reason).toBe('ok');
  });

  it('silently skips malformed scope_keys', async () => {
    const { pool, queries } = makePool([
      { scope_key: 'malformed',                   alpha_sum: '1', beta_sum: '1', contributor_count: 5, catalog_version: 'v1' },
      { scope_key: 'reviewer:plan_review:stable', alpha_sum: '1', beta_sum: '1', contributor_count: 5, catalog_version: 'v1' },
    ]);
    const seeder = new PgBanditPriorsSeeder(pool, makeModes(true));
    const out = await seeder.seedPriors(tenantId);

    expect(out.armsSeeded).toBe(1);
    expect(out.slotsConsidered).toBe(2);
    const inserts = queries.filter((q) => q.text.includes('INSERT INTO oweibo.tenant_bandit_arms'));
    expect(inserts).toHaveLength(1);
  });
});
