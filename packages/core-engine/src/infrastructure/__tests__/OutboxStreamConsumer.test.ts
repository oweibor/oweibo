/**
 * F.6 — OutboxStreamConsumer tests.
 */
import {
  OutboxStreamConsumer,
  parseXReadResult,
  type IDedupStore,
  type IRedisStreamClient,
  type OutboxStreamHandler,
} from '../OutboxStreamConsumer.js';

function fakeRedis(responses: Array<unknown>): {
  client: IRedisStreamClient;
  calls: { command: string; args: (string | number)[] }[];
  } {
  const calls: { command: string; args: (string | number)[] }[] = [];
  let i = 0;
  const client: IRedisStreamClient = {
    call: jest.fn().mockImplementation((command: string, ...args: (string | number)[]) => {
      calls.push({ command, args });
      const next = responses[i] ?? null;
      i += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    }),
  };
  return { client, calls };
}

function memoryDedupStore(): IDedupStore & { store: Map<string, Set<string>>; pruneCount: number } {
  const store = new Map<string, Set<string>>();
  return {
    store,
    pruneCount: 0,
    async hasBeenProcessed(group, eventId) {
      return store.get(group)?.has(eventId) === true;
    },
    async markProcessed(group, eventId) {
      if (!store.has(group)) store.set(group, new Set());
      store.get(group)!.add(eventId);
    },
    async pruneOlderThan(_days) {
      this.pruneCount += 1;
      return 0;
    },
  };
}

const silent = () => undefined;

describe('parseXReadResult', () => {
  it('extracts payload + eventId fields from the canonical Redis Streams shape', () => {
    const raw = [
      ['oweibo.lifecycle.tenant.created.v1', [
        ['1715-0', ['payload', '{"x":1}', 'eventId', 'evt-1']],
        ['1716-0', ['payload', '{"x":2}', 'eventId', 'evt-2']],
      ]],
    ];
    const out = parseXReadResult(raw, 'oweibo.lifecycle.tenant.created.v1');
    expect(out).toEqual([
      { streamId: '1715-0', eventId: 'evt-1', payload: '{"x":1}' },
      { streamId: '1716-0', eventId: 'evt-2', payload: '{"x":2}' },
    ]);
  });

  it('falls back to streamId when eventId field is absent', () => {
    const raw = [['s', [['100-0', ['payload', '{}']]]]];
    expect(parseXReadResult(raw, 's')).toEqual([
      { streamId: '100-0', eventId: '100-0', payload: '{}' },
    ]);
  });

  it('filters out streams whose name does not match expected', () => {
    const raw = [['other', [['1-0', ['payload', '{}']]]]];
    expect(parseXReadResult(raw, 'expected')).toEqual([]);
  });

  it('returns empty when raw is null (BLOCK timeout)', () => {
    expect(parseXReadResult(null, 'x')).toEqual([]);
  });

  it('skips entries with missing payload field', () => {
    const raw = [['s', [['1-0', ['eventId', 'e1']]]]];
    expect(parseXReadResult(raw, 's')).toEqual([]);
  });
});

describe('OutboxStreamConsumer.ensureGroup', () => {
  it('creates the group when XGROUP CREATE succeeds', async () => {
    const { client, calls } = fakeRedis(['OK']);
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: memoryDedupStore(), log: silent,
    }, jest.fn());
    await c.ensureGroup();
    expect(calls[0]?.command).toBe('XGROUP');
    expect(calls[0]?.args).toEqual(['CREATE', 's', 'g', '$', 'MKSTREAM']);
  });

  it('swallows BUSYGROUP (group already exists) as a no-op', async () => {
    const { client } = fakeRedis([new Error('BUSYGROUP Consumer Group name already exists')]);
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: memoryDedupStore(), log: silent,
    }, jest.fn());
    await expect(c.ensureGroup()).resolves.toBeUndefined();
  });

  it('rethrows non-BUSYGROUP errors', async () => {
    const { client } = fakeRedis([new Error('NOAUTH Authentication required')]);
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: memoryDedupStore(), log: silent,
    }, jest.fn());
    await expect(c.ensureGroup()).rejects.toThrow(/NOAUTH/);
  });
});

describe('OutboxStreamConsumer message processing', () => {
  it('calls handler, marks dedup, and XACKs on success', async () => {
    const dedup = memoryDedupStore();
    const xread = [['s', [['1-0', ['payload', '{"x":1}', 'eventId', 'evt-1']]]]];
    const { client, calls } = fakeRedis([xread, 'OK' /* XACK */]);
    const handler: OutboxStreamHandler = jest.fn().mockResolvedValue(undefined);
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: dedup, blockMs: 1, log: silent,
    }, handler);

    // Drive one loop iteration manually.
    await (c as unknown as { readBatch(): Promise<void> }).readBatch();
    expect(handler).toHaveBeenCalledWith({ streamId: '1-0', eventId: 'evt-1', payload: '{"x":1}' });
    expect(await dedup.hasBeenProcessed('g', 'evt-1')).toBe(true);
    const xack = calls.find((c) => c.command === 'XACK');
    expect(xack?.args).toEqual(['s', 'g', '1-0']);
  });

  it('idempotent: a previously-processed eventId is XACKed without re-invoking handler', async () => {
    const dedup = memoryDedupStore();
    await dedup.markProcessed('g', 'evt-dup');
    const xread = [['s', [['2-0', ['payload', '{}', 'eventId', 'evt-dup']]]]];
    const { client, calls } = fakeRedis([xread, 'OK']);
    const handler: OutboxStreamHandler = jest.fn();
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: dedup, blockMs: 1, log: silent,
    }, handler);

    await (c as unknown as { readBatch(): Promise<void> }).readBatch();
    expect(handler).not.toHaveBeenCalled();
    const xack = calls.find((c) => c.command === 'XACK');
    expect(xack).toBeDefined();
  });

  it('handler throwing: does NOT XACK, does NOT mark dedup (leaves in PEL for XCLAIM)', async () => {
    const dedup = memoryDedupStore();
    const xread = [['s', [['3-0', ['payload', '{}', 'eventId', 'evt-fail']]]]];
    const { client, calls } = fakeRedis([xread]);
    const handler: OutboxStreamHandler = jest.fn().mockRejectedValue(new Error('downstream blew up'));
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: dedup, blockMs: 1, log: silent,
    }, handler);

    await (c as unknown as { readBatch(): Promise<void> }).readBatch();
    expect(handler).toHaveBeenCalled();
    expect(await dedup.hasBeenProcessed('g', 'evt-fail')).toBe(false);
    expect(calls.find((c) => c.command === 'XACK')).toBeUndefined();
  });

  it('passes the eventId field through to the handler', async () => {
    const xread = [['s', [['4-0', ['payload', '{"a":1}', 'eventId', 'tenant-uuid']]]]];
    const { client } = fakeRedis([xread, 'OK']);
    const seen: string[] = [];
    const handler: OutboxStreamHandler = jest.fn().mockImplementation(async (m) => { seen.push(m.eventId); });
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: memoryDedupStore(), blockMs: 1, log: silent,
    }, handler);
    await (c as unknown as { readBatch(): Promise<void> }).readBatch();
    expect(seen).toEqual(['tenant-uuid']);
  });

  it('two-consumer simulation: same event delivered to both yields exactly one handler call total', async () => {
    const dedup = memoryDedupStore();
    const handler: OutboxStreamHandler = jest.fn();
    const message = [['s', [['5-0', ['payload', '{}', 'eventId', 'unique-evt']]]]];

    const { client: cA } = fakeRedis([message, 'OK']);
    const { client: cB } = fakeRedis([message, 'OK']);

    const consumerA = new OutboxStreamConsumer(cA, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'A', dedupStore: dedup, blockMs: 1, log: silent,
    }, handler);
    const consumerB = new OutboxStreamConsumer(cB, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'B', dedupStore: dedup, blockMs: 1, log: silent,
    }, handler);

    await (consumerA as unknown as { readBatch(): Promise<void> }).readBatch();
    await (consumerB as unknown as { readBatch(): Promise<void> }).readBatch();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('OutboxStreamConsumer start/stop', () => {
  it('start/stop is idempotent', () => {
    const { client } = fakeRedis([]);
    const c = new OutboxStreamConsumer(client, {
      streamKey: 's', consumerGroup: 'g', consumerName: 'c', dedupStore: memoryDedupStore(), log: silent,
    }, jest.fn());
    c.start();
    c.start(); // no-op
    c.stop();
    c.stop(); // no-op
    expect(true).toBe(true);
  });
});
