/**
 * EmailChannel unit tests — uses a fake nodemailer transport and a stub
 * SecretsManager. No live SMTP required.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Transporter } from 'nodemailer';
import { EmailChannel } from '../EmailChannel.js';
import type {
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface QueryStub {
  match: string;
  rows: Record<string, unknown>[];
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
      command: '', oid: 0, fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

class FakeSecrets {
  constructor(public readonly infra: unknown) {}
  async getInfraCredentials(_n?: string): Promise<unknown> { return this.infra; }
  async getSecret(_p: string): Promise<string> { return ''; }
  async getSecretOrNull(_p: string): Promise<string | null> { return null; }
  async getLangfuseCredentials(): Promise<unknown> { return null; }
  async getExportSigningKey(): Promise<unknown> { return null; }
  async getDatabaseCredentials(): Promise<unknown> { return null; }
  async getLLMApiKey(_p?: string): Promise<unknown> { return null; }
  async putSecret(_p: string, _v: string): Promise<void> { /* no-op */ }
}
const asSecretsManager = (f: FakeSecrets) =>
  f as unknown as import('../../../secrets/SecretsManager.js').SecretsManager;

class FakeTransport {
  public sends: unknown[] = [];
  public throwOnSend: Error | null = null;
  async sendMail(opts: unknown): Promise<{ messageId: string }> {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sends.push(opts);
    return { messageId: 'msg-1' };
  }
}
const asTransporter = (t: FakeTransport): Transporter => t as unknown as Transporter;

const smtp = {
  host: 'smtp.relay.test',
  port: 587,
  user: 'u',
  pass: 'p',
  fromAddress: 'platform@example',
};

const baseReq: NotificationDispatchRequest = {
  tenantId:        TENANT,
  proposalId:      '22222222-2222-2222-2222-222222222222',
  recipientHandle: 'alice@example.com',
  channelKind:     'email',
  fireEvent:       'initial',
  title:           'Approval requested',
  body:            'Please review action #1',
  linkPath:        'https://admin/approvals/22222222',
};

describe('EmailChannel', () => {
  it('returns failed when recipientHandle is missing', async () => {
    const { pool } = makePool([]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)));
    const r = await ch.dispatch({ ...baseReq, recipientHandle: undefined });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/recipientHandle/);
  });

  it('returns failed when recipientHandle is not a valid email', async () => {
    const { pool } = makePool([]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)));
    const r = await ch.dispatch({ ...baseReq, recipientHandle: 'not-an-email' });
    expect(r.status).toBe('failed');
  });

  it('returns failed when SMTP secret is missing', async () => {
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(null)));
    const r = await ch.dispatch(baseReq);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/infra\/smtp/);
  });

  it('returns failed when SMTP secret is missing required fields', async () => {
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets({ host: 'h' })));
    const r = await ch.dispatch(baseReq);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/missing field/);
  });

  it('sends mail with platform default from-address when no tenant config', async () => {
    const transport = new FakeTransport();
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)), {
      transportFactory: () => asTransporter(transport),
    });
    const r = await ch.dispatch(baseReq);
    expect(r.status).toBe('delivered');
    expect(transport.sends).toHaveLength(1);
    const sent = transport.sends[0] as { from: string; to: string; subject: string; text: string };
    expect(sent.from).toBe('platform@example');
    expect(sent.to).toBe('alice@example.com');
    expect(sent.subject).toBe('Approval requested');
    expect(sent.text).toMatch(/Please review action #1/);
    expect(sent.text).toMatch(/Link: https:\/\/admin\/approvals/);
  });

  it('uses per-tenant from-address override when configured', async () => {
    const transport = new FakeTransport();
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: { fromAddress: 'noreply@tenant', replyTo: 'support@tenant' }, enabled: true }],
    }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)), {
      transportFactory: () => asTransporter(transport),
    });
    const r = await ch.dispatch(baseReq);
    expect(r.status).toBe('delivered');
    const sent = transport.sends[0] as { from: string; replyTo?: string };
    expect(sent.from).toBe('noreply@tenant');
    expect(sent.replyTo).toBe('support@tenant');
  });

  it('returns failed when the tenant has disabled email', async () => {
    const transport = new FakeTransport();
    const { pool } = makePool([{
      match: 'FROM oweibo.tenant_notification_channel_config',
      rows: [{ config: {}, enabled: false }],
    }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)), {
      transportFactory: () => asTransporter(transport),
    });
    const r = await ch.dispatch(baseReq);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/disabled/);
    expect(transport.sends).toHaveLength(0);
  });

  it('returns failed when sendMail throws', async () => {
    const transport = new FakeTransport();
    transport.throwOnSend = new Error('connection refused');
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)), {
      transportFactory: () => asTransporter(transport),
    });
    const r = await ch.dispatch(baseReq);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/sendMail failed/);
  });

  it('caches the transport across dispatches with the same SMTP config', async () => {
    const transport = new FakeTransport();
    const calls = { factory: 0 };
    const { pool } = makePool([{ match: 'FROM oweibo.tenant_notification_channel_config', rows: [] }]);
    const ch = new EmailChannel(pool, asSecretsManager(new FakeSecrets(smtp)), {
      transportFactory: () => { calls.factory++; return asTransporter(transport); },
    });
    await ch.dispatch(baseReq);
    await ch.dispatch(baseReq);
    expect(calls.factory).toBe(1);
  });
});
