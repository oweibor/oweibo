/**
 * Unit tests for SlackRollbackAdapter.
 *
 * Stubs fetch + token resolver — no live Slack calls.
 */
import type { RollbackContext, RollbackEnvelope } from '@oweibo/core-contracts';
import {
  SlackRollbackAdapter,
  type SlackTokenResolver,
} from '../SlackRollbackAdapter.js';

const ctx: RollbackContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  originalActionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  originalPlanId: null,
  invokedBy: { type: 'human', id: 'operator' },
  correlationId: 'corr-1',
};

const goodPlan = {
  channelId: 'C01234567',
  messageTs: '1700000000.000100',
  originalText: 'Production deploy scheduled for 17:00 UTC',
};

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

class FixedResolver implements SlackTokenResolver {
  constructor(private readonly token: string | null) {}
  async resolve(): Promise<string | null> { return this.token; }
}

class ThrowingResolver implements SlackTokenResolver {
  async resolve(): Promise<string | null> { throw new Error('vault offline'); }
}

describe('SlackRollbackAdapter.preflight', () => {
  it('refuses envelope.kind=irreversible', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'));
    const env: RollbackEnvelope = { kind: 'irreversible', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/irreversible/);
  });

  it('refuses missing rollbackPlan', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'));
    await expect(adapter.preflight({ kind: 'trivial', details: '' }, ctx)).rejects.toThrow(/missing rollbackPlan/);
  });

  it('refuses missing channelId', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: { channelId: '', messageTs: 't' } };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/channelId/);
  });

  it('refuses missing messageTs', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: { channelId: 'C1', messageTs: '' } };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/messageTs/);
  });

  it('refuses when resolver returns null', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver(null));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).rejects.toThrow(/no token/);
  });

  it('passes preflight when all is in place', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'));
    const env: RollbackEnvelope = { kind: 'trivial', details: '', rollbackPlan: goodPlan };
    await expect(adapter.preflight(env, ctx)).resolves.toBeUndefined();
  });
});

describe('SlackRollbackAdapter.execute', () => {
  it('posts a thread reply with Bearer token + channelId + thread_ts', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true, ts: '1700000100.000200' });
    }) as unknown as typeof fetch;
    const adapter = new SlackRollbackAdapter(new FixedResolver('xoxb-tok'), { fetchImpl });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.state).toBe('fully_reverted');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-tok');
    const body = JSON.parse(calls[0]!.init.body as string) as { channel: string; thread_ts: string; text: string };
    expect(body.channel).toBe('C01234567');
    expect(body.thread_ts).toBe('1700000000.000100');
    expect(body.text).toMatch(/retracted/);
    expect(r.sideEffects).toContain('slack.retraction_ts=1700000100.000200');
  });

  it('returns failed when token resolver throws', async () => {
    const adapter = new SlackRollbackAdapter(new ThrowingResolver(), { fetchImpl: jest.fn() as unknown as typeof fetch });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/vault offline/);
  });

  it('returns failed when token resolver returns null at execute', async () => {
    const adapter = new SlackRollbackAdapter(new FixedResolver(null), { fetchImpl: jest.fn() as unknown as typeof fetch });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/no token/);
  });

  it('returns failed on Slack ok=false', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: false, error: 'channel_not_found' })) as unknown as typeof fetch;
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'), { fetchImpl });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.success).toBe(false);
    expect(r.details).toMatch(/channel_not_found/);
  });

  it('returns failed on HTTP non-2xx', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'), { fetchImpl });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.details).toMatch(/HTTP 500/);
  });

  it('returns failed on network error', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'), { fetchImpl });
    const r = await adapter.execute({ kind: 'trivial', details: '', rollbackPlan: goodPlan }, ctx);
    expect(r.details).toMatch(/ECONNRESET/);
  });

  it('uses plan.retractionText when supplied', async () => {
    const fetchImpl = jest.fn(async (_u, init?) => {
      const body = JSON.parse((init?.body ?? '{}') as string) as { text: string };
      expect(body.text).toBe('manual retraction');
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const adapter = new SlackRollbackAdapter(new FixedResolver('tok'), { fetchImpl });
    await adapter.execute({
      kind: 'trivial', details: '',
      rollbackPlan: { ...goodPlan, retractionText: 'manual retraction' },
    }, ctx);
  });
});
