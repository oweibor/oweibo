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
      eventId: 'r1',
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

// ── F.6: dual-write + streams-only modes ────────────────────────────────

interface StreamingPublisher extends OutboxPublisher {
  published: { channel: string; payload: string }[];
  streamed:  { stream: string; payload: string; eventId?: string; maxLen?: number }[];
  failPublishNext: number;
  failStreamNext: number;
}

function makeStreamingPublisher(): StreamingPublisher {
  const pub: StreamingPublisher = {
    published: [],
    streamed:  [],
    failPublishNext: 0,
    failStreamNext: 0,
    publish: jest.fn().mockImplementation(async (channel: string, payload: string) => {
      if (pub.failPublishNext > 0) { pub.failPublishNext -= 1; throw new Error('pub/sub down'); }
      pub.published.push({ channel, payload });
    }),
    addToStream: jest.fn().mockImplementation(async (stream: string, payload: string, opts?: { eventId?: string; maxLen?: number }) => {
      if (pub.failStreamNext > 0) { pub.failStreamNext -= 1; throw new Error('XADD down'); }
      pub.streamed.push({ stream, payload, ...(opts ?? {}) });
    }),
  };
  return pub;
}

describe('OutboxRelay F.6 dual-write', () => {
  it('default mode: pub/sub only, no XADD even if publisher supports it', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, subject, payload', rows: [{ id: 'r1', subject: 'tenant.created.v1', payload: {} }] },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const pub = makeStreamingPublisher();
    const relay = new OutboxRelay(pool, pub, { log: silent });
    await relay.tick();
    expect(pub.published).toHaveLength(1);
    expect(pub.streamed).toHaveLength(0);
  });

  it('streamsDualWriteEnabled: writes to BOTH pub/sub and XADD', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, subject, payload', rows: [{ id: 'r1', subject: 'tenant.created.v1', payload: { x: 1 } }] },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const pub = makeStreamingPublisher();
    const relay = new OutboxRelay(pool, pub, { log: silent, streamsDualWriteEnabled: true });
    const n = await relay.tick();
    expect(n).toBe(1);
    expect(pub.published).toHaveLength(1);
    expect(pub.streamed).toHaveLength(1);
    expect(pub.streamed[0]?.stream).toBe('oweibo.lifecycle.tenant.created.v1');
    expect(pub.streamed[0]?.eventId).toBe('r1');
    expect(pub.streamed[0]?.maxLen).toBe(100_000);
    const parsed = JSON.parse(pub.streamed[0]!.payload);
    expect(parsed).toEqual({ eventId: 'r1', subject: 'tenant.created.v1', payload: { x: 1 } });
  });

  it('streamsOnlyEnabled (and dualWrite=false): skips PUBLISH, XADD only', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, subject, payload', rows: [{ id: 'r2', subject: 'tenant.created.v1', payload: {} }] },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const pub = makeStreamingPublisher();
    const relay = new OutboxRelay(pool, pub, { log: silent, streamsOnlyEnabled: true });
    await relay.tick();
    expect(pub.published).toHaveLength(0);
    expect(pub.streamed).toHaveLength(1);
  });

  it('honours custom streamMaxLen', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, subject, payload', rows: [{ id: 'r3', subject: 'x', payload: {} }] },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const pub = makeStreamingPublisher();
    const relay = new OutboxRelay(pool, pub, { log: silent, streamsOnlyEnabled: true, streamMaxLen: 500 });
    await relay.tick();
    expect(pub.streamed[0]?.maxLen).toBe(500);
  });

  it('dual-write: XADD failure marks row failed even if PUBLISH succeeded', async () => {
    const { pool, calls } = makePool([
      { match: 'SELECT id, subject, payload', rows: [{ id: 'r4', subject: 'x', payload: {} }] },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const pub = makeStreamingPublisher();
    pub.failStreamNext = 1;
    const relay = new OutboxRelay(pool, pub, { log: silent, streamsDualWriteEnabled: true });
    const n = await relay.tick();
    expect(n).toBe(0); // row stays unpublished
    expect(pub.published).toHaveLength(1); // pub/sub did succeed but row not marked
    const update = calls.find((c) => c.sql.includes('UPDATE oweibo.outbox') && c.sql.includes('published_at = NOW()'));
    expect(update).toBeUndefined();
  });

  it('throws at construction time when streams flag is set but publisher lacks addToStream', () => {
    const { pool } = makePool([]);
    const basicPub: OutboxPublisher = { publish: jest.fn() };
    expect(() => new OutboxRelay(pool, basicPub, { streamsDualWriteEnabled: true }))
      .toThrow(/streamsDualWriteEnabled.*addToStream/);
    expect(() => new OutboxRelay(pool, basicPub, { streamsOnlyEnabled: true }))
      .toThrow(/streamsOnlyEnabled.*addToStream/);
  });

  it('dual-write disabled trumps streams-only=false; pure pubsub still works', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, subject, payload', rows: [{ id: 'r5', subject: 'x', payload: {} }] },
      { match: 'UPDATE oweibo.outbox', rows: [] },
    ]);
    const pub = makeStreamingPublisher();
    // Both flags off — falls back to legacy pub/sub.
    const relay = new OutboxRelay(pool, pub, { log: silent });
    await relay.tick();
    expect(pub.published).toHaveLength(1);
    expect(pub.streamed).toHaveLength(0);
  });

  it('per-transport retry: PUBLISH succeeds + XADD fails, next tick re-runs XADD ONLY (no double-PUBLISH)', async () => {
    // Same row appears in two consecutive SELECTs since we never marked it published.
    let selectCount = 0;
    const row = { id: 'r-retry', subject: 'tenant.created.v1', payload: { tenantId: 't1' } };
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      if (sql.includes('SELECT id, subject, payload')) {
        selectCount += 1;
        return Promise.resolve({ rows: [row], rowCount: 1, command: '', oid: 0, fields: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = { query: jest.fn().mockImplementation(queryFn), release: jest.fn() } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;

    const pub = makeStreamingPublisher();
    pub.failStreamNext = 1; // First XADD throws; subsequent succeeds.
    const relay = new OutboxRelay(pool, pub, { log: silent, streamsDualWriteEnabled: true });

    // Tick 1: PUBLISH ok, XADD fails → row stays unpublished, transport-success map remembers pubsub=true.
    await relay.tick();
    expect(pub.published).toHaveLength(1);
    expect(pub.streamed).toHaveLength(0);

    // Tick 2: PUBLISH skipped (already done), XADD retried + succeeds → row marked published.
    await relay.tick();
    expect(pub.published).toHaveLength(1); // No double publish!
    expect(pub.streamed).toHaveLength(1);
    expect(selectCount).toBe(2); // The row reappeared in the second SELECT.
  });

  it('per-transport retry: XADD succeeds + PUBLISH fails, next tick re-runs PUBLISH ONLY (no double-XADD)', async () => {
    const row = { id: 'r-retry-2', subject: 'x', payload: {} };
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      if (sql.includes('SELECT id, subject, payload')) {
        return Promise.resolve({ rows: [row], rowCount: 1, command: '', oid: 0, fields: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = { query: jest.fn().mockImplementation(queryFn), release: jest.fn() } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;

    const pub = makeStreamingPublisher();
    pub.failPublishNext = 1; // PUBLISH throws first time; XADD always succeeds.
    const relay = new OutboxRelay(pool, pub, { log: silent, streamsDualWriteEnabled: true });

    // Tick 1: PUBLISH throws BEFORE XADD runs → both pending.
    await relay.tick();
    expect(pub.published).toHaveLength(0);
    expect(pub.streamed).toHaveLength(0);

    // Tick 2: PUBLISH succeeds, XADD succeeds → row published exactly once across both transports.
    await relay.tick();
    expect(pub.published).toHaveLength(1);
    expect(pub.streamed).toHaveLength(1);
  });
});
