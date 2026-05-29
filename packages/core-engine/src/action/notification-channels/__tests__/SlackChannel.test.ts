/**
 * SlackChannel unit tests — uses a fake fetch implementation; no live
 * Slack API calls.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { SlackChannel } from '../SlackChannel.js';
import type {
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROPOSAL = '22222222-2222-2222-2222-222222222222';

interface QueryStub { match: string; rows: Record<string, unknown>[]; }

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    return Promise.resolve({
      rows: stub ? stub.rows : [], rowCount: stub ? stub.rows.length : 0,
      command: '', oid: 0, fields: [],
    });
  };
  const client = { query: jest.fn().mockImplementation(queryFn), release: jest.fn() } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

class FakeSecrets {
  constructor(public readonly tokenByKid: Record<string, string> = {}) {}
  async getSecret(p: string): Promise<string> {
    const v = this.tokenByKid[p];
    if (v === undefined) throw new Error(`secret not found: ${p}`);
    return v;
  }
  async getInfraCredentials(_n?: string): Promise<unknown> { return null; }
  async getSecretOrNull(p: string): Promise<string | null> { return this.tokenByKid[p] ?? null; }
  async getLangfuseCredentials(): Promise<unknown> { return null; }
  async getExportSigningKey(): Promise<unknown> { return null; }
  async getDatabaseCredentials(): Promise<unknown> { return null; }
  async getLLMApiKey(_p?: string): Promise<unknown> { return null; }
  async putSecret(_p: string, _v: string): Promise<void> { /* no-op */ }
}
const asSecretsManager = (f: FakeSecrets) =>
  f as unknown as import('../../../secrets/SecretsManager.js').SecretsManager;

const req: NotificationDispatchRequest = {
  tenantId:        TENANT,
  proposalId:      PROPOSAL,
  channelKind:     'slack',
  fireEvent:       'initial',
  title:           'Approve deploy',
  body:            'Step 3 awaiting approval',
  linkPath:        'https://admin/approvals/22222222',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(),
    redirected: false, type: 'basic', url: '',
    bodyUsed: false, body: null,
    clone() { return this; },
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(body),
    json: async () => body,
    bytes: async () => new Uint8Array(),
  } as unknown as Response;
}

describe('SlackChannel', () => {
  it('returns failed when the tenant has no slack config row', async () => {
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets()), {
      fetchImpl: jest.fn(),
    });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/no slack config/);
  });

  it('returns failed when the slack row is disabled', async () => {
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'C1', oauthSecretKid: 'k' }, enabled: false }],
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets()), { fetchImpl: jest.fn() });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/no slack config/);
  });

  it('returns failed when channelId or oauthSecretKid are missing from config', async () => {
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'C1' }, enabled: true }],   // missing oauthSecretKid
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets()), { fetchImpl: jest.fn() });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
  });

  it('posts to chat.postMessage with bearer token + channel + title text', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true, ts: '1700000000.000100' });
    }) as unknown as typeof fetch;
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'C01', oauthSecretKid: 'infra/slack/t' }, enabled: true }],
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets({ 'infra/slack/t': 'xoxb-tok' })), {
      fetchImpl,
    });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xoxb-tok');
    const body = JSON.parse(calls[0]!.init.body as string) as { channel: string; text: string };
    expect(body.channel).toBe('C01');
    expect(body.text).toMatch(/Approve deploy/);
  });

  it('returns failed when Slack API responds with ok=false', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: false, error: 'channel_not_found' })) as unknown as typeof fetch;
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'CX', oauthSecretKid: 'k' }, enabled: true }],
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets({ k: 'xoxb-tok' })), { fetchImpl });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/channel_not_found/);
  });

  it('returns failed when HTTP status is non-2xx', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: false }, 500)) as unknown as typeof fetch;
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'C1', oauthSecretKid: 'k' }, enabled: true }],
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets({ k: 'tok' })), { fetchImpl });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/HTTP 500/);
  });

  it('returns failed when fetch itself throws (network error)', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'C1', oauthSecretKid: 'k' }, enabled: true }],
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets({ k: 'tok' })), { fetchImpl });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/ECONNRESET/);
  });

  it('returns failed when secrets lookup fails', async () => {
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { channelId: 'C1', oauthSecretKid: 'missing' }, enabled: true }],
    }]);
    const ch = new SlackChannel(pool, asSecretsManager(new FakeSecrets({})), {
      fetchImpl: jest.fn() as unknown as typeof fetch,
    });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/token lookup failed/);
  });
});
