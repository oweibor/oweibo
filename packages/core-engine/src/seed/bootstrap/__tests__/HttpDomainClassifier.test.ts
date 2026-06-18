/**
 * B.2: HttpDomainClassifier tests — fake fetch records calls + drives responses.
 */
import { HttpDomainClassifier, HttpStatusError, computeIdempotencyKey } from '../HttpDomainClassifier.js';

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
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

const okResponse = {
  classifiedDomain: 'finance',
  classifiedConfidence: 0.82,
  recommendedTemplate: 'finance-template',
  recommendedConnectors: ['slack', 'github'],
  recommendedSeedSkills: ['code-review-pass'],
};

describe('HttpDomainClassifier', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const sampleInput = {
    interviewAnswers: [{ question: 'industry?', answer: 'capital markets' }],
    primerExcerpts: ['quant trading platform'],
    repoSignals: { languages: ['Scala'], frameworks: [], notes: [] },
  };

  it('constructor throws when apiBaseUrl is missing', () => {
    expect(() => new HttpDomainClassifier({ apiBaseUrl: '', internalToken: 't' }))
      .toThrow(/apiBaseUrl required/);
  });

  it('constructor throws when internalToken is missing', () => {
    expect(() => new HttpDomainClassifier({ apiBaseUrl: 'http://x', internalToken: '' }))
      .toThrow(/internalToken required/);
  });

  it('POSTs to /api/v1/_internal/domain/classify with Bearer auth + idempotency key', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(JSON.stringify(okResponse)));
    const c = new HttpDomainClassifier({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await c.classify(tenantId, sampleInput);
    expect(out.classifiedDomain).toBe('finance');
    expect(out.classifiedConfidence).toBeCloseTo(0.82);
    expect(out.recommendedTemplate).toBe('finance-template');
    expect(out.recommendedConnectors).toEqual(['slack', 'github']);
    expect(out.recommendedSeedSkills).toEqual(['code-review-pass']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://x/api/v1/_internal/domain/classify');
    expect(calls[0]!.headers['authorization']).toBe('Bearer t');
    expect(calls[0]!.headers['x-tenant-id']).toBe(tenantId);
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^[a-f0-9]{64}$/);
    // Body contains tenantId + the input fields, flattened.
    expect(calls[0]!.body['tenantId']).toBe(tenantId);
    expect(calls[0]!.body['interviewAnswers']).toEqual(sampleInput.interviewAnswers);
    expect(calls[0]!.body['primerExcerpts']).toEqual(sampleInput.primerExcerpts);
  });

  it('passes through null classifiedDomain when the server signals unclassified', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify({
      classifiedDomain: null,
      classifiedConfidence: 0.1,
      recommendedTemplate: null,
      recommendedConnectors: [],
      recommendedSeedSkills: [],
    })));
    const c = new HttpDomainClassifier({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await c.classify(tenantId, sampleInput);
    expect(out.classifiedDomain).toBeNull();
    expect(out.recommendedConnectors).toEqual([]);
    expect(out.recommendedSeedSkills).toEqual([]);
  });

  it('defaults recommendedConnectors/SeedSkills to [] when omitted by server', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify({
      classifiedDomain: 'finance',
      classifiedConfidence: 0.9,
      recommendedTemplate: null,
    })));
    const c = new HttpDomainClassifier({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await c.classify(tenantId, sampleInput);
    expect(out.recommendedConnectors).toEqual([]);
    expect(out.recommendedSeedSkills).toEqual([]);
  });

  it('retries on 5xx then succeeds', async () => {
    let count = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      count += 1;
      if (count === 1) return new Response('boom', { status: 502 });
      return new Response(JSON.stringify(okResponse));
    });
    const c = new HttpDomainClassifier({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    const out = await c.classify(tenantId, sampleInput);
    expect(out.classifiedDomain).toBe('finance');
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry on 4xx — surfaces HttpStatusError', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      new Response('{"error":"bad"}', { status: 400 }),
    );
    const c = new HttpDomainClassifier({ apiBaseUrl: 'http://x', internalToken: 't', fetchImpl });
    await expect(c.classify(tenantId, sampleInput)).rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toHaveLength(1);
  });

  it('Idempotency-Key is deterministic for same payload', () => {
    const body1 = JSON.stringify({ tenantId, foo: 1 });
    const a = computeIdempotencyKey(tenantId, body1);
    const b = computeIdempotencyKey(tenantId, body1);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('Idempotency-Key differs for different payloads', () => {
    const a = computeIdempotencyKey(tenantId, '{"x":1}');
    const b = computeIdempotencyKey(tenantId, '{"x":2}');
    expect(a).not.toBe(b);
  });
});
