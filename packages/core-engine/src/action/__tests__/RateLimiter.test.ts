/**
 * S.2 — RateLimiter integration tests.
 *
 * Mocks the pg pool for tenant.created_at + event-log writes. Uses
 * InMemoryTokenBucketStore for the bucket math (so we test the real
 * combine logic, not a stub).
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { RateLimiter } from '../RateLimiter.js';
import { InMemoryTokenBucketStore } from '../TokenBucketStore.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface QueryStub { match: string; rows: QueryResultRow[]; }

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
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
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

const silent = () => undefined;

describe('RateLimiter.tryConsume', () => {
  it('returns allowed when flag is off (no DB, no store interaction)', async () => {
    const { pool, calls } = makePool([]);
    const store = new InMemoryTokenBucketStore();
    const rl = new RateLimiter(pool, store, { isEnabled: () => false, log: silent });
    const r = await rl.tryConsume(TENANT, 'irreversible.delete_resource');
    expect(r.kind).toBe('allowed');
    expect(calls).toHaveLength(0);
  });

  it('returns allowed when bucket has capacity', async () => {
    const { pool } = makePool([
      // No tenant_policy override → use platform default
      { match: 'FROM oweibo.rate_limit_policies', rows: [] },
      { match: 'FROM oweibo.tenants WHERE id', rows: [{ created_at: new Date(0) }] },
    ]);
    const store = new InMemoryTokenBucketStore();
    const rl = new RateLimiter(pool, store, { isEnabled: () => true, log: silent });
    const r = await rl.tryConsume(TENANT, 'read.tenant_db');
    expect(r.kind).toBe('allowed');
  });

  it('returns soft when bucket is empty under soft enforcement', async () => {
    let nowMs = 1_700_000_000_000;
    const { pool } = makePool([
      { match: 'FROM oweibo.rate_limit_policies', rows: [] },
      { match: 'FROM oweibo.tenants WHERE id', rows: [{ created_at: new Date(0) }] },
    ]);
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    const rl = new RateLimiter(pool, store, {
      isEnabled: () => true,
      now: () => new Date(nowMs),
      log: silent,
    });
    // financial.payment is soft enforcement with perMinute=5. Drain it.
    for (let i = 0; i < 7; i++) await rl.tryConsume(TENANT, 'financial.payment'); // 5 + 2 burst
    const r = await rl.tryConsume(TENANT, 'financial.payment');
    expect(r.kind).toBe('soft');
    if (r.kind === 'soft') {
      expect(r.retryAfterMs).toBeGreaterThan(0);
      expect(r.limitingWindow).toBe('minute');
    }
  });

  it('returns hard (forbidden) when bucket is empty under hard enforcement (irreversible.*)', async () => {
    let nowMs = 1_700_000_000_000;
    const { pool } = makePool([
      { match: 'FROM oweibo.rate_limit_policies', rows: [] },
      { match: 'FROM oweibo.tenants WHERE id', rows: [{ created_at: new Date(0) }] },
    ]);
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    const rl = new RateLimiter(pool, store, {
      isEnabled: () => true,
      now: () => new Date(nowMs),
      log: silent,
    });
    // irreversible.delete_resource: perMinute=2, burst=1 → 3 tokens.
    for (let i = 0; i < 3; i++) await rl.tryConsume(TENANT, 'irreversible.delete_resource');
    const r = await rl.tryConsume(TENANT, 'irreversible.delete_resource');
    expect(r.kind).toBe('hard');
    if (r.kind === 'hard') expect(r.reason).toBe('rate_limit_exceeded');
  });

  it('applies cold-start multiplier to a fresh tenant', async () => {
    let nowMs = new Date('2026-01-02T00:00:00Z').getTime(); // day 1 of tenant
    const created = new Date('2026-01-01T00:00:00Z');
    const { pool } = makePool([
      { match: 'FROM oweibo.rate_limit_policies', rows: [] },
      { match: 'FROM oweibo.tenants WHERE id', rows: [{ created_at: created }] },
    ]);
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    const rl = new RateLimiter(pool, store, {
      isEnabled: () => true,
      now: () => new Date(nowMs),
      log: silent,
    });
    // financial.payment cold-start: 0.10 × 5 = 0 → floor to 1; + 2 burst → still tightened
    // Drain quickly to demonstrate tighter window.
    for (let i = 0; i < 3; i++) await rl.tryConsume(TENANT, 'financial.payment');
    const r = await rl.tryConsume(TENANT, 'financial.payment');
    expect(r.kind).not.toBe('allowed');
  });

  it('writes a rate_limit_events row on throttle', async () => {
    let nowMs = 1_700_000_000_000;
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.rate_limit_policies', rows: [] },
      { match: 'FROM oweibo.tenants WHERE id', rows: [{ created_at: new Date(0) }] },
    ]);
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    const rl = new RateLimiter(pool, store, {
      isEnabled: () => true,
      now: () => new Date(nowMs),
      log: silent,
    });
    for (let i = 0; i < 3; i++) await rl.tryConsume(TENANT, 'irreversible.delete_resource');
    await rl.tryConsume(TENANT, 'irreversible.delete_resource');
    // Allow microtask drain for fire-and-forget event log.
    await new Promise((r) => setImmediate(r));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.rate_limit_events'));
    expect(insert).toBeDefined();
    expect(insert?.params[3]).toBe('throttled_hard');
  });

  it('caches tenant created_at to avoid a DB hit on every call', async () => {
    let nowMs = 1_700_000_000_000;
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.rate_limit_policies', rows: [] },
      { match: 'FROM oweibo.tenants WHERE id', rows: [{ created_at: new Date(0) }] },
    ]);
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    const rl = new RateLimiter(pool, store, {
      isEnabled: () => true,
      now: () => new Date(nowMs),
      log: silent,
    });
    await rl.tryConsume(TENANT, 'read.tenant_db');
    await rl.tryConsume(TENANT, 'read.tenant_db');
    await rl.tryConsume(TENANT, 'read.tenant_db');
    const tenantQueries = calls.filter((c) => c.sql.includes('FROM oweibo.tenants WHERE id'));
    expect(tenantQueries).toHaveLength(1);
  });
});
