/**
 * F.5.9 — HttpMemoryWriter tests. Uses a fake fetch implementation.
 */
import { HttpMemoryWriter, HttpStatusError } from '../HttpMemoryWriter.js';
import type { SeedMemoryRequest } from '../JsonSeedCatalogProvider.js';

function seed(id: string): SeedMemoryRequest {
  return {
    seedId: id, catalogVersion: 'v1', kind: 'episodic', summary: id,
    importance: 0.5, tags: [`seed:${id}`],
  };
}

function recordingFetch(
  responder: (call: { url: string; body: { seeds: SeedMemoryRequest[] } }) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; body: { seeds: SeedMemoryRequest[] } }[] } {
  const calls: { url: string; body: { seeds: SeedMemoryRequest[] } }[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: BodyInit }) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : { seeds: [] };
    const call = { url, body };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('HttpMemoryWriter', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('returns empty result when no seeds supplied', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response('{}'));
    const writer = new HttpMemoryWriter({
      apiBaseUrl: 'http://x', internalToken: 't', fetchImpl,
    });
    const out = await writer.writeSeeds(tenantId, []);
    expect(out).toEqual({ inserted: [], skipped: [], failed: [] });
    expect(calls).toHaveLength(0);
  });

  it('POSTs to /api/v1/_internal/memories/seed with Bearer auth + tenant header', async () => {
    let headersSeen: Record<string, string> = {};
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response(JSON.stringify({ inserted: ['a'], skipped: [], failed: [] })),
    );
    const wrap: typeof fetch = (async (input: unknown, init?: { headers?: HeadersInit }) => {
      headersSeen = Object.fromEntries(new Headers(init?.headers).entries());
      return fetchImpl(input as never, init as never);
    }) as unknown as typeof fetch;
    const writer = new HttpMemoryWriter({
      apiBaseUrl: 'http://x', internalToken: 't', fetchImpl: wrap,
    });

    await writer.writeSeeds(tenantId, [seed('a')]);
    expect(calls[0]!.url).toBe('http://x/api/v1/_internal/memories/seed');
    expect(headersSeen['authorization']).toBe('Bearer t');
    expect(headersSeen['x-tenant-id']).toBe(tenantId);
  });

  it('batches into groups of 20 (default) when more seeds are supplied', async () => {
    const { fetchImpl, calls } = recordingFetch(({ body }) =>
      new Response(JSON.stringify({ inserted: body.seeds.map((s) => s.seedId), skipped: [], failed: [] })),
    );
    const writer = new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });

    const fifty = Array.from({ length: 50 }, (_, i) => seed(`s${i}`));
    const out = await writer.writeSeeds(tenantId, fifty);

    expect(calls).toHaveLength(3); // 20 + 20 + 10
    expect(calls[0]!.body.seeds).toHaveLength(20);
    expect(calls[2]!.body.seeds).toHaveLength(10);
    expect(out.inserted).toHaveLength(50);
  });

  it('honors a custom batchSize', async () => {
    const { fetchImpl, calls } = recordingFetch(({ body }) =>
      new Response(JSON.stringify({ inserted: body.seeds.map((s) => s.seedId), skipped: [], failed: [] })),
    );
    const writer = new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl, batchSize: 5 });
    await writer.writeSeeds(tenantId, Array.from({ length: 7 }, (_, i) => seed(`s${i}`)));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.seeds).toHaveLength(5);
    expect(calls[1]!.body.seeds).toHaveLength(2);
  });

  it('aggregates server-side inserted/skipped/failed counts across batches', async () => {
    let call = 0;
    const { fetchImpl } = recordingFetch(({ body }) => {
      call += 1;
      const ids = body.seeds.map((s) => s.seedId);
      if (call === 1) {
        return new Response(JSON.stringify({ inserted: ids.slice(0, 2), skipped: ids.slice(2), failed: [] }));
      }
      return new Response(JSON.stringify({ inserted: ids, skipped: [], failed: [] }));
    });
    const writer = new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl, batchSize: 4 });
    const out = await writer.writeSeeds(tenantId, Array.from({ length: 6 }, (_, i) => seed(`s${i}`)));
    expect(out.inserted).toHaveLength(2 + 2);
    expect(out.skipped).toHaveLength(2);
    expect(out.failed).toEqual([]);
  });

  it('retries 5xx responses with backoff (eventually succeeds)', async () => {
    let call = 0;
    const { fetchImpl } = recordingFetch(({ body }) => {
      call += 1;
      if (call < 2) return new Response('boom', { status: 503 });
      return new Response(JSON.stringify({ inserted: body.seeds.map((s) => s.seedId), skipped: [], failed: [] }));
    });
    const writer = new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await writer.writeSeeds(tenantId, [seed('a')]);
    expect(out.inserted).toEqual(['a']);
    expect(call).toBe(2);
  });

  it('places batch into failed[] when all retries exhausted', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('still bad', { status: 503 }));
    const writer = new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await writer.writeSeeds(tenantId, [seed('a'), seed('b')]);
    expect(out.inserted).toEqual([]);
    expect(out.failed).toHaveLength(2);
    expect(out.failed[0]).toContain('503');
  });

  it('does NOT retry 4xx responses', async () => {
    let call = 0;
    const { fetchImpl } = recordingFetch(() => {
      call += 1;
      return new Response('bad request', { status: 400 });
    });
    const writer = new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await writer.writeSeeds(tenantId, [seed('a')]);
    expect(call).toBe(1); // single attempt, no retries
    expect(out.failed).toHaveLength(1);
  });

  it('constructor throws on empty apiBaseUrl', () => {
    expect(() => new HttpMemoryWriter({ apiBaseUrl: '', internalToken: 't' })).toThrow(/apiBaseUrl required/);
  });

  it('constructor throws on empty internalToken', () => {
    expect(() => new HttpMemoryWriter({ apiBaseUrl: 'http://x', internalToken: '' })).toThrow(/internalToken required/);
  });

  it('HttpStatusError carries the status code', () => {
    const e = new HttpStatusError(503, 'down');
    expect(e.status).toBe(503);
    expect(e.name).toBe('HttpStatusError');
  });
});
