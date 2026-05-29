/**
 * Unit tests for DeployRollbackAdapter.
 *
 * Stubs fetch + DeployConfigResolver. Covers preflight refusals, HMAC
 * signing, URL construction, response parsing, and the "any non-2xx is
 * failed" path.
 */
import { createHmac } from 'crypto';
import type { RollbackContext, RollbackEnvelope } from '@oweibo/core-contracts';
import {
  DeployRollbackAdapter,
  type DeployConfig,
  type DeployConfigResolver,
} from '../DeployRollbackAdapter.js';

const ctx: RollbackContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  originalActionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  originalPlanId: null,
  invokedBy: { type: 'human', id: 'operator' },
  correlationId: 'corr-xyz',
};

const goodPlan = {
  deploymentId: 'dep-2026-05-29-r1',
  environment: 'prod',
  reason: 'rollback for incident #42',
};

class FixedResolver implements DeployConfigResolver {
  constructor(private readonly cfg: DeployConfig | null) {}
  async resolve(): Promise<DeployConfig | null> { return this.cfg; }
}

class ThrowingResolver implements DeployConfigResolver {
  async resolve(): Promise<DeployConfig | null> { throw new Error('vault down'); }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status, statusText: 'OK', headers: new Headers(),
    redirected: false, type: 'basic', url: '', bodyUsed: false, body: null,
    clone() { return this; },
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(body),
    json: async () => body,
    bytes: async () => new Uint8Array(),
  } as unknown as Response;
}

describe('DeployRollbackAdapter.preflight', () => {
  it('refuses envelope.kind=irreversible', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }));
    const env: RollbackEnvelope = { kind: 'irreversible', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/irreversible/);
  });

  it('refuses missing rollbackPlan', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }));
    await expect(adapter.preflight({ kind: 'trivial', details: '' }, ctx)).rejects.toThrow(/missing rollbackPlan/);
  });

  it('refuses malformed deploymentId', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }));
    const env: RollbackEnvelope = {
      kind: 'trivial', details: '',
      rollbackPlan: { deploymentId: '../../etc/passwd' },
    };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/deploymentId/);
  });

  it('refuses when resolver returns null', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver(null));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/no deploy config/);
  });

  it('refuses non-https baseUrl to a non-loopback host', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver({ baseUrl: 'http://deploy.internal', hmacSecret: null }));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/insecure baseUrl/);
  });

  it('accepts http://localhost', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver({ baseUrl: 'http://localhost:8080', hmacSecret: null }));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).resolves.toBeUndefined();
  });

  it('refuses malformed baseUrl', async () => {
    const adapter = new DeployRollbackAdapter(new FixedResolver({ baseUrl: 'not a url', hmacSecret: null }));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/malformed baseUrl/);
  });
});

describe('DeployRollbackAdapter.execute', () => {
  it('POSTs to <baseUrl>/rollback/<deploymentId> with correlationId in body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const adapter = new DeployRollbackAdapter(
      new FixedResolver({ baseUrl: 'https://deploy.test/api', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('fully_reverted');
    expect(calls[0]!.url).toBe(`https://deploy.test/api/rollback/${encodeURIComponent(goodPlan.deploymentId)}`);
    const body = JSON.parse(calls[0]!.init.body as string) as { correlationId: string };
    expect(body.correlationId).toBe('corr-xyz');
  });

  it('signs the body with HMAC-SHA256 when hmacSecret is set', async () => {
    let capturedSig: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = jest.fn(async (_u, init?) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      capturedSig = h['X-Oweibo-Signature'];
      capturedBody = init?.body as string;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const secret = 'shared-secret';
    const adapter = new DeployRollbackAdapter(
      new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: secret }),
      { fetchImpl },
    );
    await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(capturedSig).toBeDefined();
    expect(capturedSig!.startsWith('v1=')).toBe(true);
    const expected = createHmac('sha256', secret).update(capturedBody!).digest('hex');
    expect(capturedSig).toBe(`v1=${expected}`);
  });

  it('returns failed on HTTP non-2xx', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    const adapter = new DeployRollbackAdapter(
      new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.details).toMatch(/HTTP 503/);
  });

  it('returns failed when resolver throws', async () => {
    const adapter = new DeployRollbackAdapter(new ThrowingResolver(), { fetchImpl: jest.fn() as unknown as typeof fetch });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.details).toMatch(/vault down/);
  });

  it('returns failed on network error', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const adapter = new DeployRollbackAdapter(
      new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.details).toMatch(/ETIMEDOUT/);
  });

  it('honours server-supplied state/details when 2xx', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      state: 'partial', details: 'rollback queued, 3 of 5 nodes reverted', costUsdCents: 12,
    })) as unknown as typeof fetch;
    const adapter = new DeployRollbackAdapter(
      new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('partial');
    expect(r.details).toMatch(/3 of 5/);
    expect(r.costUsdCents).toBe(12);
  });

  it('defaults sideEffects to deploy.rollback_started=<id>', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const adapter = new DeployRollbackAdapter(
      new FixedResolver({ baseUrl: 'https://deploy.test', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.sideEffects).toContain(`deploy.rollback_started=${goodPlan.deploymentId}`);
  });
});
