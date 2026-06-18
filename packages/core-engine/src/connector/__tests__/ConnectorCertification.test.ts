/**
 * D.4 — ConnectorCertification tests.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ConnectorCertification } from '../ConnectorCertification.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
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
  const pool = {
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

describe('ConnectorCertification.recordCertification', () => {
  it('writes a row with the supplied fields', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.connector_certifications', rows: [] },
    ]);
    const svc = new ConnectorCertification(pool);
    await svc.recordCertification({
      connectorId: 'slack',
      catalogVersion: '1.0.0',
      certificationTier: 'verified',
      certifiedFor: ['devops'],
      testSuiteHash: 'abc123',
      certifier: 'ci',
    });
    const insert = calls.find((c) =>
      c.sql.includes('INSERT INTO oweibo.connector_certifications'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('slack');
    expect(insert!.params).toContain('1.0.0');
    expect(insert!.params).toContain('verified');
    expect(insert!.params).toContain('abc123');
    expect(insert!.params).toContain('ci');
  });

  it('rolls back on insert failure', async () => {
    const calls: { sql: string }[] = [];
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      calls.push({ sql });
      if (sql.includes('INSERT INTO oweibo.connector_certifications')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = {
      query: jest.fn().mockImplementation(queryFn),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const svc = new ConnectorCertification(pool);
    await expect(
      svc.recordCertification({
        connectorId: 'slack',
        catalogVersion: '1.0.0',
        certificationTier: 'community',
        certifiedFor: [],
        testSuiteHash: 'h',
        certifier: 'ci',
      }),
    ).rejects.toThrow(/boom/);
    expect(calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });
});

describe('ConnectorCertification.lookupCertification', () => {
  it('returns the record when present, parsing dates to ISO strings', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT connector_id, catalog_version',
        rows: [
          {
            connector_id: 'slack',
            catalog_version: '1.0.0',
            certification_tier: 'verified',
            certified_for: ['devops'],
            test_suite_hash: 'abc',
            passed_at: new Date('2026-05-28T00:00:00Z'),
            expires_at: null,
            certifier: 'ci',
            metadata: { ran_by: 'unit-test' },
          },
        ],
      },
    ]);
    const svc = new ConnectorCertification(pool);
    const r = await svc.lookupCertification('slack', '1.0.0');
    expect(r).not.toBeNull();
    expect(r!.connectorId).toBe('slack');
    expect(r!.certificationTier).toBe('verified');
    expect(r!.certifiedFor).toEqual(['devops']);
    expect(r!.passedAt).toBe('2026-05-28T00:00:00.000Z');
    expect(r!.expiresAt).toBeNull();
  });

  it('returns null when not present', async () => {
    const { pool } = makePool([{ match: 'SELECT connector_id', rows: [] }]);
    const svc = new ConnectorCertification(pool);
    expect(await svc.lookupCertification('nope', '1.0.0')).toBeNull();
  });
});

describe('ConnectorCertification.listForConnector', () => {
  it('returns every catalog_version record for the connector', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT connector_id, catalog_version',
        rows: [
          {
            connector_id: 'slack',
            catalog_version: '1.1.0',
            certification_tier: 'enterprise',
            certified_for: ['devops'],
            test_suite_hash: 'h2',
            passed_at: new Date('2026-06-01T00:00:00Z'),
            expires_at: new Date('2027-06-01T00:00:00Z'),
            certifier: 'ci',
            metadata: {},
          },
          {
            connector_id: 'slack',
            catalog_version: '1.0.0',
            certification_tier: 'verified',
            certified_for: ['devops'],
            test_suite_hash: 'h1',
            passed_at: new Date('2026-05-28T00:00:00Z'),
            expires_at: null,
            certifier: 'ci',
            metadata: {},
          },
        ],
      },
    ]);
    const svc = new ConnectorCertification(pool);
    const all = await svc.listForConnector('slack');
    expect(all).toHaveLength(2);
    expect(all[0]!.catalogVersion).toBe('1.1.0');
    expect(all[1]!.catalogVersion).toBe('1.0.0');
  });
});
