/**
 * B.1: HttpSkillSeeder tests — fake fetch records calls + drives responses.
 */
import { HttpSkillSeeder, HttpStatusError, computeIdempotencyKey } from '../HttpSkillSeeder.js';

interface RecordedCall {
  url: string;
  body: { tenantId: string; bundlePath: string };
  headers: Record<string, string>;
}

function recordingFetch(responder: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: BodyInit; headers?: HeadersInit }) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: RecordedCall = { url, body, headers };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('HttpSkillSeeder', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const bundlePath = '/var/lib/oweibo/skills/starter';

  it('constructor throws when apiBaseUrl is missing', () => {
    expect(() => new HttpSkillSeeder({ apiBaseUrl: '', internalToken: 't' }))
      .toThrow(/apiBaseUrl required/);
  });

  it('constructor throws when internalToken is missing', () => {
    expect(() => new HttpSkillSeeder({ apiBaseUrl: 'http://x', internalToken: '' }))
      .toThrow(/internalToken required/);
  });

  it('POSTs to /api/v1/_internal/skills/seed with Bearer auth + idempotency key', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response(JSON.stringify({ registered: ['skill-a'], failed: [] })),
    );
    const seeder = new HttpSkillSeeder({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await seeder.seedSkills(tenantId, bundlePath);
    expect(out).toEqual({ registered: ['skill-a'], failed: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://x/api/v1/_internal/skills/seed');
    expect(calls[0]!.body).toEqual({ tenantId, bundlePath });
    expect(calls[0]!.headers['authorization']).toBe('Bearer t');
    expect(calls[0]!.headers['x-tenant-id']).toBe(tenantId);
    expect(calls[0]!.headers['idempotency-key']).toBe(computeIdempotencyKey(tenantId, bundlePath));
  });

  it('strips trailing slash from apiBaseUrl', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response(JSON.stringify({ registered: [], failed: [] })),
    );
    const seeder = new HttpSkillSeeder({ apiBaseUrl: 'http://x/', internalToken: 't', fetchImpl });
    await seeder.seedSkills(tenantId, bundlePath);
    expect(calls[0]!.url).toBe('http://x/api/v1/_internal/skills/seed');
  });

  it('passes the server response through verbatim', async () => {
    const { fetchImpl } = recordingFetch(() =>
      new Response(JSON.stringify({ registered: ['a', 'b'], failed: ['c: bad'] })),
    );
    const seeder = new HttpSkillSeeder({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await seeder.seedSkills(tenantId, bundlePath);
    expect(out.registered).toEqual(['a', 'b']);
    expect(out.failed).toEqual(['c: bad']);
  });

  it('retries on 5xx then succeeds', async () => {
    let count = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      count += 1;
      if (count === 1) return new Response('boom', { status: 503 });
      return new Response(JSON.stringify({ registered: ['a'], failed: [] }));
    });
    const seeder = new HttpSkillSeeder({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await seeder.seedSkills(tenantId, bundlePath);
    expect(out.registered).toEqual(['a']);
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry on 4xx — surfaces HttpStatusError', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response('{"error":"bad"}', { status: 400 }),
    );
    const seeder = new HttpSkillSeeder({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    await expect(seeder.seedSkills(tenantId, bundlePath))
      .rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toHaveLength(1);
  });

  it('retries on TypeError (network drop) up to 2 times then throws', async () => {
    let count = 0;
    const fetchImpl = (async () => {
      count += 1;
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const seeder = new HttpSkillSeeder({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    await expect(seeder.seedSkills(tenantId, bundlePath)).rejects.toThrow(/connection refused/);
    expect(count).toBe(3); // initial + 2 retries
  });

  it('Idempotency-Key is deterministic for same (tenantId, bundlePath)', () => {
    const a = computeIdempotencyKey(tenantId, bundlePath);
    const b = computeIdempotencyKey(tenantId, bundlePath);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('Idempotency-Key differs for different bundlePaths', () => {
    const a = computeIdempotencyKey(tenantId, '/var/lib/oweibo/skills/foo');
    const b = computeIdempotencyKey(tenantId, '/var/lib/oweibo/skills/bar');
    expect(a).not.toBe(b);
  });
});
