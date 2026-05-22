/**
 * Unit tests for OutboxRelay — verify drain semantics, publish-failure
 * fail-open, and dead-letter accounting against a mock pool + publisher.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { OutboxRelay, type OutboxPublisher } from '../OutboxRelay.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
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
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

interface RecordingPublisher extends OutboxPublisher {
  published: { channel: string; payload: string }[];
  failNext: number;
}

function makePublisher(failNext = 0): RecordingPublisher {
  const pub: RecordingPublisher = {
    published: [],
    failNext,
    publish: jest.fn().mockImplementation(async (channel: string, payload: string) => {
      if (pub.failNext > 0) {
        pub.failNext -= 1;
        throw new Error('redis unavailable');
      }
      pub.published.push({ channel, payload });
    }),
  };
  return pub;
}

const silent = () => undefined;

describe('OutboxRelay.tick', () => {
  it('publishes nothing when no unpublished rows', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, subject, payload', rows: [] },
    ]);
    const publisher = makePublisher();
    const relay = new OutboxRelay(pool, publisher, { log: silent });
    const n = await relay.tick();
    expect(n).toBe(0);
    expect(publisher.published).toHaveLength(0);
  });

  it('publishes each row to oweibo.lifecycle.<subject> and marks published_at', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT id, subject, payload',
        rows: [
          { id: 'r1', subject: 'tenant.created.v1', payload: { tenantId: 't1' } },
          { id: 'r2', subject: 'tenant.created.v1', payload: { tenantId: 't2' } },
        ],
      },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const publisher = makePublisher();
    const relay = new OutboxRelay(pool, publisher, { log: silent });
    const n = await relay.tick();
    expect(n).toBe(2);
    expect(publisher.published).toHaveLength(2);
    expect(publisher.published[0]?.channel).toBe('oweibo.lifecycle.tenant.created.v1');
    expect(JSON.parse(publisher.published[0]?.payload ?? '{}')).toEqual({
      subject: 'tenant.created.v1',
      payload: { tenantId: 't1' },
    });
    const update = calls.find((c) => c.sql.includes('UPDATE oweibo.outbox') && c.sql.includes('published_at = NOW()'));
    expect(update).toBeDefined();
    expect(update?.params[0]).toEqual(['r1', 'r2']);
  });

  it('fails open: publish failure does NOT mark row published or throw', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT id, subject, payload',
        rows: [{ id: 'r1', subject: 'tenant.created.v1', payload: {} }],
      },
    ]);
    const publisher = makePublisher(99); // fail many times
    const relay = new OutboxRelay(pool, publisher, { log: silent });
    const n = await relay.tick();
    expect(n).toBe(0);
    // No published_at UPDATE should be issued — the row is left for retry.
    const upd = calls.find((c) => c.sql.includes('UPDATE oweibo.outbox'));
    expect(upd).toBeUndefined();
  });

  it('uses FOR UPDATE SKIP LOCKED for cooperative draining', async () => {
    const { pool, calls } = makePool([
      { match: 'FOR UPDATE SKIP LOCKED', rows: [] },
    ]);
    const publisher = makePublisher();
    const relay = new OutboxRelay(pool, publisher, { log: silent });
    await relay.tick();
    const selectCall = calls.find((c) => c.sql.includes('SELECT id, subject, payload'));
    expect(selectCall?.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('partial batch: publishes some, leaves failures', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT id, subject, payload',
        rows: [
          { id: 'r1', subject: 'tenant.created.v1', payload: {} },
          { id: 'r2', subject: 'tenant.created.v1', payload: {} },
        ],
      },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const publisher = makePublisher(1); // first publish fails
    const relay = new OutboxRelay(pool, publisher, { log: silent });
    const n = await relay.tick();
    expect(n).toBe(1);
    const update = calls.find((c) => c.sql.includes('UPDATE oweibo.outbox') && c.sql.includes('published_at = NOW()'));
    expect(update?.params[0]).toEqual(['r2']);
  });

  it('dead-letters a row after maxAttemptsPerRow', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT id, subject, payload',
        rows: [{ id: 'r1', subject: 'tenant.created.v1', payload: {} }],
      },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const publisher = makePublisher(999);
    const relay = new OutboxRelay(pool, publisher, { log: silent, maxAttemptsPerRow: 3 });
    // Tick 1, 2: failures, no DB write
    await relay.tick();
    await relay.tick();
    // Tick 3: should trigger dead-letter on this row
    await relay.tick();
    const deadLetter = calls.find((c) =>
      c.sql.includes('UPDATE oweibo.outbox')
      && c.sql.includes('_dead_letter'),
    );
    expect(deadLetter).toBeDefined();
    expect(deadLetter?.params[0]).toEqual(['r1']);
  });

  it('start/stop wires and clears the interval timer', () => {
    const { pool } = makePool([]);
    const publisher = makePublisher();
    const relay = new OutboxRelay(pool, publisher, { intervalMs: 50, log: silent });
    relay.start();
    relay.start(); // idempotent
    relay.stop();
    relay.stop(); // idempotent
    expect(true).toBe(true);
  });

  it('a re-entrant tick (still running) returns 0 without double work', async () => {
    // Make pool.connect hang on the first call but resolve immediately when allowed.
    let connectResolve!: (v: PoolClient) => void;
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn().mockImplementationOnce(
        () => new Promise<PoolClient>((resolve) => { connectResolve = resolve; }),
      ).mockResolvedValue(client),
    } as unknown as Pool;

    const publisher = makePublisher();
    const relay = new OutboxRelay(pool, publisher, { log: silent });

    const first = relay.tick();
    // Give the first tick one microtask hop so it enters and sets running=true
    await Promise.resolve();
    const second = await relay.tick();
    expect(second).toBe(0);

    // Allow the first tick to complete cleanly.
    connectResolve(client);
    await first;
  });
});
