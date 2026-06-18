/**
 * WebhookChannel unit tests — uses fake fetch + a stub resolver. No live
 * network calls.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createHmac } from 'crypto';
import { WebhookChannel } from '../WebhookChannel.js';
import type {
  IWebhookConfigResolver,
  ResolvedWebhookConfig,
  WebhookKind,
} from '../../PgWebhookConfigResolver.js';
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

class FakeResolver implements IWebhookConfigResolver {
  constructor(public cfg: ResolvedWebhookConfig | null | Error) {}
  async resolve(_t: string, _k: WebhookKind): Promise<ResolvedWebhookConfig | null> {
    if (this.cfg instanceof Error) throw this.cfg;
    return this.cfg;
  }
  invalidate(_t: string, _k: WebhookKind): void { /* no-op */ }
}

function ok(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status, statusText: 'OK', headers: new Headers(),
    redirected: false, type: 'basic', url: '', bodyUsed: false, body: null,
    clone() { return this; },
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => '',
    json: async () => ({}),
    bytes: async () => new Uint8Array(),
  } as unknown as Response;
}

const req: NotificationDispatchRequest = {
  tenantId:        TENANT,
  proposalId:      PROPOSAL,
  channelKind:     'webhook',
  fireEvent:       'initial',
  title:           'Approval requested',
  body:            'Step 1 needs review',
  linkPath:        'https://admin/approvals',
  urgency:         'normal',
};

describe('WebhookChannel', () => {
  it('returns failed when tenantId is malformed', async () => {
    const { pool } = makePool([]);
    const ch = new WebhookChannel(pool, new FakeResolver(null), {
      fetchImpl: jest.fn() as unknown as typeof fetch,
    });
    const r = await ch.dispatch({ ...req, tenantId: 'not-a-uuid' });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/invalid tenantId/);
  });

  it('returns failed when the tenant has no webhook configured', async () => {
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new WebhookChannel(pool, new FakeResolver(null), {
      fetchImpl: jest.fn() as unknown as typeof fetch,
    });
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/no webhook configured/);
  });

  it('returns failed when the channel_config row is disabled', async () => {
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ enabled: false }],
    }]);
    const ch = new WebhookChannel(
      pool,
      new FakeResolver({ url: 'https://h', hmacSecret: null }),
      { fetchImpl: jest.fn() as unknown as typeof fetch },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/disabled/);
  });

  it('POSTs JSON to the resolved URL without a signature header when no hmacSecret', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return ok();
    }) as unknown as typeof fetch;
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new WebhookChannel(
      pool,
      new FakeResolver({ url: 'https://hooks.test/notify', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hooks.test/notify');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Oweibo-Signature']).toBeUndefined();
    expect(headers['X-Oweibo-Timestamp']).toBeDefined();
    expect(headers['Content-Type']).toMatch(/application\/json/);
    const body = JSON.parse(calls[0]!.init.body as string) as { tenantId: string; title: string };
    expect(body.tenantId).toBe(TENANT);
    expect(body.title).toBe('Approval requested');
  });

  it('signs the payload with HMAC-SHA256 when hmacSecret is set', async () => {
    let capturedSig: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = jest.fn(async (_u: string | URL, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      capturedSig = h['X-Oweibo-Signature'];
      capturedBody = init?.body as string;
      return ok();
    }) as unknown as typeof fetch;
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const secret = 'shared-secret';
    const ch = new WebhookChannel(
      pool,
      new FakeResolver({ url: 'https://hooks/n', hmacSecret: secret }),
      { fetchImpl },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('delivered');
    expect(capturedSig).toBeDefined();
    expect(capturedSig!.startsWith('v1=')).toBe(true);
    const expected = createHmac('sha256', secret).update(capturedBody!).digest('hex');
    expect(capturedSig).toBe(`v1=${expected}`);
  });

  it('returns failed on non-2xx response', async () => {
    const fetchImpl = jest.fn(async () => ok(503)) as unknown as typeof fetch;
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new WebhookChannel(
      pool,
      new FakeResolver({ url: 'https://hooks', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/HTTP 503/);
  });

  it('returns failed on network error', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new WebhookChannel(
      pool,
      new FakeResolver({ url: 'https://hooks', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/ETIMEDOUT/);
  });

  it('returns failed when the resolver throws', async () => {
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new WebhookChannel(
      pool,
      new FakeResolver(new Error('vault down')),
      { fetchImpl: jest.fn() as unknown as typeof fetch },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/vault down/);
  });

  it('treats an absent channel_config row as enabled (resolver is the gate)', async () => {
    const fetchImpl = jest.fn(async () => ok()) as unknown as typeof fetch;
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new WebhookChannel(
      pool,
      new FakeResolver({ url: 'https://hooks', hmacSecret: null }),
      { fetchImpl },
    );
    const r = await ch.dispatch(req);
    expect(r.status).toBe('delivered');
  });
});
