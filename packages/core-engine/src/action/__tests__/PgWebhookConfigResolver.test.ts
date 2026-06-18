/**
 * Unit tests for PgWebhookConfigResolver.
 *
 * Covers: tenant scoping (SET LOCAL), most-recently-updated row selection,
 * SecretsManager-backed HMAC resolution, 60s TTL caching, manual invalidate,
 * malformed tenantId rejection, and the "no webhook configured" path.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  PgWebhookConfigResolver,
  type WebhookKind,
} from '../PgWebhookConfigResolver.js';

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
      command: '',
      oid: 0,
      fields: [],
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
  public readonly store: Map<string, string>;
  public lookups: string[] = [];
  constructor(entries: Record<string, string> = {}) {
    this.store = new Map(Object.entries(entries));
  }
  async getSecret(path: string): Promise<string> {
    this.lookups.push(path);
    const v = this.store.get(path);
    if (v === undefined) throw new Error(`secret not found: ${path}`);
    return v;
  }
  async getSecretOrNull(path: string): Promise<string | null> { return this.store.get(path) ?? null; }
  async getInfraCredentials(_n?: string): Promise<unknown> { return null; }
  async getLangfuseCredentials(): Promise<unknown> { return null; }
  async getExportSigningKey(): Promise<unknown> { return null; }
  async getDatabaseCredentials(): Promise<unknown> { return null; }
  async getLLMApiKey(_p?: string): Promise<unknown> { return null; }
  async putSecret(p: string, v: string): Promise<void> { this.store.set(p, v); }
}

function asSecretsManager(fake: FakeSecrets): import('../../secrets/SecretsManager.js').SecretsManager {
  return fake as unknown as import('../../secrets/SecretsManager.js').SecretsManager;
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('PgWebhookConfigResolver', () => {
  it('returns null when no webhook is configured for (tenant, kind)', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_webhook_configs', rows: [] },
    ]);
    const secrets = new FakeSecrets();
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(secrets));
    expect(await r.resolve(TENANT_A, 'rollback')).toBeNull();
  });

  it('returns url + plaintext hmacSecret resolved via SecretsManager', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_webhook_configs',
        rows: [{ url: 'https://hooks.example/r', hmac_secret_kid: 'infra/webhook-hmac/abc' }],
      },
    ]);
    const secrets = new FakeSecrets({ 'infra/webhook-hmac/abc': 'secret-bytes-hex' });
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(secrets));

    const cfg = await r.resolve(TENANT_A, 'notification');
    expect(cfg).toEqual({ url: 'https://hooks.example/r', hmacSecret: 'secret-bytes-hex' });
    expect(secrets.lookups).toEqual(['infra/webhook-hmac/abc']);
  });

  it('returns hmacSecret=null when no kid is set on the row', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_webhook_configs',
        rows: [{ url: 'https://hooks.example/r', hmac_secret_kid: null }],
      },
    ]);
    const secrets = new FakeSecrets();
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(secrets));
    const cfg = await r.resolve(TENANT_A, 'rollback');
    expect(cfg).toEqual({ url: 'https://hooks.example/r', hmacSecret: null });
    expect(secrets.lookups).toEqual([]);
  });

  it('queries with SET LOCAL app.tenant_id and the requested kind', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_webhook_configs', rows: [] },
    ]);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()));
    await r.resolve(TENANT_A, 'rollback');

    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT_A}'`))).toBe(true);
    const select = calls.find(c => c.sql.includes('FROM oweibo.tenant_webhook_configs'));
    expect(select).toBeDefined();
    expect(select!.params).toEqual([TENANT_A, 'rollback']);
    expect(select!.sql).toMatch(/ORDER BY updated_at DESC/);
    expect(select!.sql).toMatch(/LIMIT 1/);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });

  it('rejects malformed tenantId without hitting the DB', async () => {
    const { pool, calls } = makePool([]);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()));
    await expect(r.resolve('not-a-uuid', 'rollback')).rejects.toThrow(/invalid tenantId/);
    expect(calls.length).toBe(0);
  });

  it('caches results within TTL — second resolve does not re-query', async () => {
    const stubs: QueryStub[] = [
      {
        match: 'FROM oweibo.tenant_webhook_configs',
        rows: [{ url: 'https://h/1', hmac_secret_kid: null }],
      },
    ];
    const { pool, calls } = makePool(stubs);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()), { cacheTtlMs: 60_000 });

    await r.resolve(TENANT_A, 'rollback');
    const firstSelectCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;

    await r.resolve(TENANT_A, 'rollback');
    const secondSelectCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;

    expect(secondSelectCount).toBe(firstSelectCount);
  });

  it('expires cache after the TTL elapses', async () => {
    let nowMs = 1_000_000;
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.tenant_webhook_configs',
        rows: [{ url: 'https://h/1', hmac_secret_kid: null }],
      },
    ]);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()), {
      cacheTtlMs: 60_000,
      now: () => nowMs,
    });
    await r.resolve(TENANT_A, 'rollback');
    nowMs += 60_001;  // past the TTL
    await r.resolve(TENANT_A, 'rollback');
    const selectCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;
    expect(selectCount).toBe(2);
  });

  it('cache is keyed by (tenantId, kind) — separate entries do not collide', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.tenant_webhook_configs',
        rows: [{ url: 'https://h/1', hmac_secret_kid: null }],
      },
    ]);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()));

    await r.resolve(TENANT_A, 'rollback');
    await r.resolve(TENANT_A, 'notification');
    await r.resolve(TENANT_B, 'rollback');

    const selectCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;
    expect(selectCount).toBe(3);

    // Hitting the same (tenant, kind) again should not re-query.
    await r.resolve(TENANT_A, 'rollback');
    const after = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;
    expect(after).toBe(3);
  });

  it('invalidate(tenantId, kind) forces a re-query on the next resolve', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.tenant_webhook_configs',
        rows: [{ url: 'https://h/1', hmac_secret_kid: null }],
      },
    ]);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()));
    await r.resolve(TENANT_A, 'rollback');
    r.invalidate(TENANT_A, 'rollback');
    await r.resolve(TENANT_A, 'rollback');
    const selectCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;
    expect(selectCount).toBe(2);
  });

  it('propagates DB errors and rolls the transaction back', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
          return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
        }
        if (sql.includes('FROM oweibo.tenant_webhook_configs')) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()));
    await expect(r.resolve(TENANT_A, 'rollback')).rejects.toThrow(/boom/);
    const queryMock = (client as { query: jest.Mock }).query;
    const sqls: string[] = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sqls).toContain('ROLLBACK');
  });

  it('caches null results too (no re-query for tenants without a webhook)', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_webhook_configs', rows: [] },
    ]);
    const r = new PgWebhookConfigResolver(pool, asSecretsManager(new FakeSecrets()));
    expect(await r.resolve(TENANT_A, 'rollback')).toBeNull();
    expect(await r.resolve(TENANT_A, 'rollback')).toBeNull();
    const selectCount = calls.filter(c => c.sql.includes('FROM oweibo.tenant_webhook_configs')).length;
    expect(selectCount).toBe(1);
  });
});

void ('WebhookKind' as WebhookKind);  // tsc check that the named export is reachable
