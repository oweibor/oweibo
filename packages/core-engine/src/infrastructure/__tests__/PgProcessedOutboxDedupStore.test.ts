/**
 * F.6 — PgProcessedOutboxDedupStore tests against a mock pool.
 */
import type { Pool, QueryResult } from 'pg';
import { PgProcessedOutboxDedupStore } from '../PgProcessedOutboxDedupStore.js';

function makePool(responses: ((sql: string, params: unknown[]) => QueryResult)[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
  } {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  const pool = {
    query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const res = (responses[i] ?? (() => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })))(sql, params ?? []);
      i += 1;
      return Promise.resolve(res);
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('PgProcessedOutboxDedupStore', () => {
  it('hasBeenProcessed returns true when EXISTS finds a row', async () => {
    const { pool } = makePool([
      () => ({ rows: [{ exists: true }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }),
    ]);
    const store = new PgProcessedOutboxDedupStore(pool);
    expect(await store.hasBeenProcessed('g1', 'evt-1')).toBe(true);
  });

  it('hasBeenProcessed returns false when EXISTS is false', async () => {
    const { pool } = makePool([
      () => ({ rows: [{ exists: false }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }),
    ]);
    const store = new PgProcessedOutboxDedupStore(pool);
    expect(await store.hasBeenProcessed('g1', 'evt-1')).toBe(false);
  });

  it('markProcessed inserts with ON CONFLICT DO NOTHING', async () => {
    const { pool, calls } = makePool([
      () => ({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] }),
    ]);
    const store = new PgProcessedOutboxDedupStore(pool);
    await store.markProcessed('g1', 'evt-1');
    expect(calls[0]!.sql).toContain('INSERT INTO oweibo.processed_outbox_events');
    expect(calls[0]!.sql).toContain('ON CONFLICT (consumer_group, event_id) DO NOTHING');
    expect(calls[0]!.params).toEqual(['g1', 'evt-1']);
  });

  it('pruneOlderThan deletes rows older than N days and returns rowCount', async () => {
    const { pool, calls } = makePool([
      () => ({ rows: [], rowCount: 7, command: 'DELETE', oid: 0, fields: [] }),
    ]);
    const store = new PgProcessedOutboxDedupStore(pool);
    const n = await store.pruneOlderThan(7);
    expect(n).toBe(7);
    expect(calls[0]!.sql).toContain('DELETE FROM oweibo.processed_outbox_events');
    expect(calls[0]!.sql).toContain("processed_at < NOW() - ($1 || ' days')::interval");
    expect(calls[0]!.params).toEqual(['7']);
  });
});
