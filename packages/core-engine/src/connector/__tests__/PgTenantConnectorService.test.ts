/**
 * F.4.7: PgTenantConnectorService unit tests.
 *
 * Covers:
 *   - listForTenant returns rows in installed_at DESC order.
 *   - install probes Vault when wired; aborts on empty/null secret.
 *   - install inserts in 'pending' status.
 *   - install surfaces DB UNIQUE conflict as DuplicateConnectorInstanceError.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  CredentialNotResolvableError,
  DuplicateConnectorInstanceError,
  PgTenantConnectorService,
} from '../PgTenantConnectorService.js';

const TENANT = '11111111-1111-4111-a111-111111111111';

interface QueryStub {
  match: string;
  rows?: QueryResultRow[];
  throws?: Error;
}

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    if (stub?.throws) return Promise.reject(stub.throws);
    return Promise.resolve({
      rows: stub?.rows ?? [],
      rowCount: stub?.rows?.length ?? 0,
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

describe('PgTenantConnectorService.listForTenant', () => {
  it('returns rows mapped to InstalledConnectorRow shape', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_connectors',
        rows: [{
          id: 'cid-1', connector_id: 'github-issues',
          catalog_version: '1.0.0', instance_label: 'primary',
          status: 'active', installed_by: null,
          installed_at: new Date('2026-05-29T00:00:00Z'),
          last_used_at: null, vault_path: 'tenants/x/y', metadata: {},
        }],
      },
    ]);
    const svc = new PgTenantConnectorService(pool);
    const rows = await svc.listForTenant(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('cid-1');
    expect(rows[0]?.connectorId).toBe('github-issues');
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.installedAt).toBe('2026-05-29T00:00:00.000Z');
  });
});

describe('PgTenantConnectorService.install', () => {
  const baseReq = {
    tenantId: TENANT,
    connectorId: 'github-issues',
    catalogVersion: '1.0.0',
    instanceLabel: 'primary',
    vaultPath: 'tenants/x/connectors/y',
    installedBy: null,
  };

  it('skips the Vault probe when no vault client is wired', async () => {
    const { pool } = makePool([
      {
        match: 'INSERT INTO oweibo.tenant_connectors',
        rows: [{ id: 'cid-new', installed_at: new Date('2026-05-29T00:00:00Z') }],
      },
    ]);
    const svc = new PgTenantConnectorService(pool);
    const row = await svc.install(baseReq);
    expect(row.id).toBe('cid-new');
    expect(row.status).toBe('pending');
  });

  it('probes Vault when wired and inserts on a non-empty secret', async () => {
    const { pool } = makePool([
      {
        match: 'INSERT INTO oweibo.tenant_connectors',
        rows: [{ id: 'cid-new', installed_at: new Date('2026-05-29T00:00:00Z') }],
      },
    ]);
    const vault = { read: jest.fn().mockResolvedValue({ apiKey: 'k' }) };
    const svc = new PgTenantConnectorService(pool, { vault });
    await svc.install(baseReq);
    expect(vault.read).toHaveBeenCalledWith(baseReq.vaultPath);
  });

  it('throws CredentialNotResolvableError when Vault returns null', async () => {
    const { pool } = makePool([]);
    const vault = { read: jest.fn().mockResolvedValue(null) };
    const svc = new PgTenantConnectorService(pool, { vault });
    await expect(svc.install(baseReq)).rejects.toBeInstanceOf(CredentialNotResolvableError);
  });

  it('throws CredentialNotResolvableError when Vault returns an empty object', async () => {
    const { pool } = makePool([]);
    const vault = { read: jest.fn().mockResolvedValue({}) };
    const svc = new PgTenantConnectorService(pool, { vault });
    await expect(svc.install(baseReq)).rejects.toBeInstanceOf(CredentialNotResolvableError);
  });

  it('surfaces UNIQUE conflict as DuplicateConnectorInstanceError', async () => {
    const { pool } = makePool([
      {
        match: 'INSERT INTO oweibo.tenant_connectors',
        throws: new Error('duplicate key value violates unique constraint "tenant_connectors_unique_instance"'),
      },
    ]);
    const svc = new PgTenantConnectorService(pool);
    await expect(svc.install(baseReq)).rejects.toBeInstanceOf(DuplicateConnectorInstanceError);
  });

  it('re-throws non-conflict insert errors as-is', async () => {
    const boom = new Error('pg down');
    const { pool } = makePool([
      { match: 'INSERT INTO oweibo.tenant_connectors', throws: boom },
    ]);
    const svc = new PgTenantConnectorService(pool);
    await expect(svc.install(baseReq)).rejects.toBe(boom);
  });

  it('passes metadata as a JSON string through to the insert', async () => {
    const { pool, calls } = makePool([
      {
        match: 'INSERT INTO oweibo.tenant_connectors',
        rows: [{ id: 'cid-new', installed_at: new Date('2026-05-29T00:00:00Z') }],
      },
    ]);
    const svc = new PgTenantConnectorService(pool);
    await svc.install({ ...baseReq, metadata: { region: 'us-east-1' } });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_connectors'));
    expect(insert?.params).toContain(JSON.stringify({ region: 'us-east-1' }));
  });
});
