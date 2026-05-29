/**
 * Unit tests for EmailDeliveredVerifier.
 */
import type { DeferredVerifierInput } from '@oweibo/core-contracts';
import { EmailDeliveredVerifier } from '../EmailDeliveredVerifier.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function deferred(verifierConfig: unknown): DeferredVerifierInput {
  return { tenantId: TENANT, proposalId: 'p-1', verifierConfig, expected: null };
}

function res(body: unknown, status = 200): Response {
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

const goodCfg = {
  receiptUrl: 'https://relay.test/v1/messages/abc',
  messageId:  'msg-abc',
};

describe('EmailDeliveredVerifier', () => {
  it('appliesTo only comm.external_email', () => {
    const v = new EmailDeliveredVerifier();
    expect(v.appliesTo('comm.external_email')).toBe(true);
    expect(v.appliesTo('comm.external_message')).toBe(false);
    expect(v.appliesTo('deploy.prod')).toBe(false);
  });

  it('returns severity 2 when config is missing', async () => {
    const v = new EmailDeliveredVerifier({ fetchImpl: jest.fn() as unknown as typeof fetch });
    const r = await v.deferred(deferred(null));
    expect(r.severity).toBe(2);
  });

  it('returns severity 0 when state=delivered', async () => {
    const fetchImpl = jest.fn(async () => res({ state: 'delivered', deliveredAt: 't' })) as unknown as typeof fetch;
    const v = new EmailDeliveredVerifier({ fetchImpl });
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(0);
  });

  it('returns severity 1 on transient queue states', async () => {
    for (const state of ['queued', 'sent', 'accepted']) {
      const fetchImpl = jest.fn(async () => res({ state })) as unknown as typeof fetch;
      const v = new EmailDeliveredVerifier({ fetchImpl });
      const r = await v.deferred(deferred(goodCfg));
      expect(r.severity).toBe(1);
    }
  });

  it('returns severity 2 on transient trouble states', async () => {
    for (const state of ['deferred', 'throttled']) {
      const fetchImpl = jest.fn(async () => res({ state })) as unknown as typeof fetch;
      const v = new EmailDeliveredVerifier({ fetchImpl });
      const r = await v.deferred(deferred(goodCfg));
      expect(r.severity).toBe(2);
    }
  });

  it('returns severity 3 on terminal-fail states', async () => {
    for (const state of ['bounced', 'failed', 'rejected', 'spam']) {
      const fetchImpl = jest.fn(async () => res({ state, reason: 'mailbox_full' })) as unknown as typeof fetch;
      const v = new EmailDeliveredVerifier({ fetchImpl });
      const r = await v.deferred(deferred(goodCfg));
      expect(r.severity).toBe(3);
    }
  });

  it('returns severity 3 when receipt is 404/410', async () => {
    for (const status of [404, 410]) {
      const fetchImpl = jest.fn(async () => res({}, status)) as unknown as typeof fetch;
      const v = new EmailDeliveredVerifier({ fetchImpl });
      const r = await v.deferred(deferred(goodCfg));
      expect(r.severity).toBe(3);
    }
  });

  it('returns severity 2 on other non-2xx', async () => {
    const fetchImpl = jest.fn(async () => res({}, 503)) as unknown as typeof fetch;
    const v = new EmailDeliveredVerifier({ fetchImpl });
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(2);
  });

  it('returns severity 3 on network error', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const v = new EmailDeliveredVerifier({ fetchImpl });
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(3);
  });

  it('returns severity 2 on unknown state', async () => {
    const fetchImpl = jest.fn(async () => res({ state: 'whatever' })) as unknown as typeof fetch;
    const v = new EmailDeliveredVerifier({ fetchImpl });
    const r = await v.deferred(deferred(goodCfg));
    expect(r.severity).toBe(2);
  });

  it('passes the auth header through when supplied', async () => {
    let captured: Record<string, string> | undefined;
    const fetchImpl = jest.fn(async (_u, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>;
      return res({ state: 'delivered' });
    }) as unknown as typeof fetch;
    const v = new EmailDeliveredVerifier({ fetchImpl });
    await v.deferred(deferred({ ...goodCfg, authHeaderValue: 'Bearer tok' }));
    expect(captured!.Authorization).toBe('Bearer tok');
  });
});
