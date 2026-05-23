/**
 * T.3.a — PriorsAggregator tests.
 *
 * Verifies:
 *   - mode gate short-circuits when disallowed
 *   - K-anonymity: groups with < K contributors are filtered out
 *   - strength cap: alpha+beta sums are scaled to respect the cap
 *   - rows that fell below K since the previous run are deleted
 *   - the writer role is requested via SET LOCAL ROLE (defensive — ignored
 *     on test DBs that don't have the role)
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PriorsAggregator, applyStrengthCap } from '../PriorsAggregator.js';

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

describe('applyStrengthCap', () => {
  it('passes through when both sums are below the cap', () => {
    const row = { scope_kind: 'prompt_slot' as const, scope_key: 'k', alpha_sum: 30, beta_sum: 20, contributor_count: 7 };
    expect(applyStrengthCap(row, 50)).toEqual(row);
  });

  it('scales both sums proportionally when the max exceeds the cap', () => {
    const row = { scope_kind: 'prompt_slot' as const, scope_key: 'k', alpha_sum: 200, beta_sum: 100, contributor_count: 7 };
    const out = applyStrengthCap(row, 50);
    expect(out.alpha_sum).toBeCloseTo(50, 5);
    expect(out.beta_sum).toBeCloseTo(25, 5);
    // Ratio preserved.
    expect(out.alpha_sum / out.beta_sum).toBeCloseTo(row.alpha_sum / row.beta_sum, 5);
  });
});

describe('PriorsAggregator.runOnce', () => {
  it('short-circuits when isAllowed returns false', async () => {
    const { pool, calls } = makePool([]);
    const a = new PriorsAggregator(pool, { isAllowed: async () => false, log: silent });
    const r = await a.runOnce();
    expect(r).toEqual({ upserted: 0, deleted: 0, filteredByKAnonymity: 0 });
    expect(calls).toHaveLength(0);
  });

  it('filters groups below K-anonymity and upserts the rest', async () => {
    const { pool, calls } = makePool([
      {
        match: 'GROUP BY pv.role, ba.slot_id, ba.channel',
        rows: [
          { scope_key: 'architect:slot1:stable', alpha_sum: '30', beta_sum: '15', contributor_count: '7' },
          { scope_key: 'architect:slot2:stable', alpha_sum: '12', beta_sum: '8',  contributor_count: '2' },
        ],
      },
      { match: "FROM oweibo.platform_bandit_priors WHERE scope_kind = 'prompt_slot'", rows: [] },
    ]);
    const a = new PriorsAggregator(pool, { kAnonymity: 5, priorStrengthCap: 100, log: silent });
    const r = await a.runOnce();
    expect(r.upserted).toBe(1);
    expect(r.filteredByKAnonymity).toBe(1);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.platform_bandit_priors'));
    expect(insert).toBeDefined();
    // params[1] is scope_key
    expect(insert?.params[1]).toBe('architect:slot1:stable');
  });

  it('applies the strength cap when alpha_sum or beta_sum exceeds it', async () => {
    const { pool, calls } = makePool([
      {
        match: 'GROUP BY pv.role, ba.slot_id, ba.channel',
        rows: [
          { scope_key: 'a:b:c', alpha_sum: '200', beta_sum: '100', contributor_count: '10' },
        ],
      },
      { match: "FROM oweibo.platform_bandit_priors WHERE scope_kind = 'prompt_slot'", rows: [] },
    ]);
    const a = new PriorsAggregator(pool, { priorStrengthCap: 50, log: silent });
    await a.runOnce();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.platform_bandit_priors'));
    // params order: scope_kind, scope_key, alpha_sum, beta_sum, contributor_count, catalog_version
    expect(insert?.params[2]).toBeCloseTo(50, 5);
    expect(insert?.params[3]).toBeCloseTo(25, 5);
  });

  it('deletes rows that fell below K-anonymity since the previous run', async () => {
    const { pool, calls } = makePool([
      {
        match: 'GROUP BY pv.role, ba.slot_id, ba.channel',
        rows: [
          { scope_key: 'still:eligible:k', alpha_sum: '30', beta_sum: '15', contributor_count: '7' },
        ],
      },
      {
        match: "FROM oweibo.platform_bandit_priors WHERE scope_kind = 'prompt_slot'",
        rows: [
          { scope_kind: 'prompt_slot', scope_key: 'still:eligible:k' },
          { scope_kind: 'prompt_slot', scope_key: 'stale:key:gone' },
        ],
      },
    ]);
    const a = new PriorsAggregator(pool, { kAnonymity: 5, log: silent });
    const r = await a.runOnce();
    expect(r.deleted).toBe(1);
    const del = calls.find((c) => c.sql.startsWith('DELETE FROM oweibo.platform_bandit_priors'));
    expect(del?.params[1]).toBe('stale:key:gone');
  });

  it('sets LOCAL ROLE platform_priors_writer (defensively catches missing role)', async () => {
    const { pool, calls } = makePool([
      { match: 'GROUP BY pv.role, ba.slot_id, ba.channel', rows: [] },
      { match: "FROM oweibo.platform_bandit_priors WHERE scope_kind = 'prompt_slot'", rows: [] },
    ]);
    const a = new PriorsAggregator(pool, { log: silent });
    await a.runOnce();
    const setRole = calls.find((c) => c.sql.includes('SET LOCAL ROLE platform_priors_writer'));
    expect(setRole).toBeDefined();
  });
});
