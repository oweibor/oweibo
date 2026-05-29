/**
 * Unit tests for runWithAdvisoryLock.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  deriveLockKey,
  runWithAdvisoryLock,
} from '../runWithAdvisoryLock.js';

interface QueryStub { match: string; rows?: Record<string, unknown>[]; throws?: Error; }

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
  client: PoolClient;
  released: () => number;
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  let releaseCount = 0;
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    if (stub?.throws) return Promise.reject(stub.throws);
    return Promise.resolve({
      rows: stub?.rows ?? [], rowCount: stub?.rows?.length ?? 0,
      command: '', oid: 0, fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(() => { releaseCount++; }),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls, client, released: () => releaseCount };
}

describe('deriveLockKey', () => {
  it('produces a stable bigint-shaped string for the same input', () => {
    const a = deriveLockKey('domain_currency_tick');
    const b = deriveLockKey('domain_currency_tick');
    expect(a).toBe(b);
    // pg-node parses bigint strings; just confirm it's signed-decimal.
    expect(a).toMatch(/^-?\d+$/);
  });

  it('produces different keys for different lockIds', () => {
    const a = deriveLockKey('domain_currency_tick');
    const b = deriveLockKey('sme_aggregator_tick');
    expect(a).not.toBe(b);
  });

  it('namespaces oweibo locks in the high 32 bits', () => {
    // Sanity: the magnitude is large enough that low-32-bit hashes alone
    // wouldn't reach it. We just confirm the absolute value > 2^48.
    const key = deriveLockKey('x');
    const big = BigInt(key);
    const abs = big < 0n ? -big : big;
    expect(abs > (1n << 48n)).toBe(true);
  });
});

describe('runWithAdvisoryLock', () => {
  it('runs the callback and returns { ran: true, result } on lock acquisition', async () => {
    const { pool, calls } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: true }] },
      { match: 'pg_advisory_unlock',   rows: [{ pg_advisory_unlock: true }] },
    ]);
    const r = await runWithAdvisoryLock(pool, 'tick-1', async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
    expect(calls.some((c) => c.sql.includes('pg_try_advisory_lock'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('returns { ran: false } when the lock is busy (callback NOT invoked)', async () => {
    const { pool, calls } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: false }] },
    ]);
    const fn = jest.fn(async () => 'never');
    const r = await runWithAdvisoryLock(pool, 'tick-1', fn);
    expect(r).toEqual({ ran: false, result: undefined });
    expect(fn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('releases the lock even when the callback throws', async () => {
    const { pool, calls } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: true }] },
      { match: 'pg_advisory_unlock',   rows: [{ pg_advisory_unlock: true }] },
    ]);
    const err = new Error('callback boom');
    await expect(runWithAdvisoryLock(pool, 'tick-1', async () => { throw err; })).rejects.toBe(err);
    expect(calls.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('releases the pool client even when the callback throws', async () => {
    const { pool, released } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: true }] },
      { match: 'pg_advisory_unlock',   rows: [{ pg_advisory_unlock: true }] },
    ]);
    await expect(runWithAdvisoryLock(pool, 'tick-1', async () => { throw new Error('x'); })).rejects.toThrow();
    expect(released()).toBe(1);
  });

  it('does NOT issue pg_advisory_unlock when the lock was never acquired', async () => {
    const { pool, calls } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: false }] },
    ]);
    await runWithAdvisoryLock(pool, 'tick-1', async () => 1);
    const unlocks = calls.filter((c) => c.sql.includes('pg_advisory_unlock'));
    expect(unlocks.length).toBe(0);
  });

  it('passes the derived lock key to pg_try_advisory_lock as a bigint', async () => {
    const { pool, calls } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: true }] },
      { match: 'pg_advisory_unlock',   rows: [{ pg_advisory_unlock: true }] },
    ]);
    await runWithAdvisoryLock(pool, 'domain_currency_tick', async () => 0);
    const lockCall = calls.find((c) => c.sql.includes('pg_try_advisory_lock'));
    expect(lockCall?.params).toEqual([deriveLockKey('domain_currency_tick')]);
  });

  it('swallows pg_advisory_unlock errors (session close releases anyway)', async () => {
    const { pool } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: true }] },
      { match: 'pg_advisory_unlock',   throws: new Error('unlock blew up') },
    ]);
    // Should NOT throw — the unlock error is logged + swallowed.
    const r = await runWithAdvisoryLock(pool, 'tick-1', async () => 'ok');
    expect(r).toEqual({ ran: true, result: 'ok' });
  });

  it('uses the supplied log function instead of console', async () => {
    const { pool } = makePool([
      { match: 'pg_try_advisory_lock', rows: [{ pg_try_advisory_lock: false }] },
    ]);
    const log = jest.fn();
    await runWithAdvisoryLock(pool, 'tick-1', async () => 0, { log });
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('busy'));
  });
});
