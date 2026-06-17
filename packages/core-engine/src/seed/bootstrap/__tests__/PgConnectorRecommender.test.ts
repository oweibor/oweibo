/**
 * F.5.1 — PgConnectorRecommender adapter tests. Mocks the pg Pool so the
 * SQL it emits is asserted by string match on the distinctive INSERT
 * clause.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { ConnectorRegistry } from '../../../connector/ConnectorRegistry.js';
import type { ConnectorCatalogEntry } from '@oweibo/core-contracts';
import { PgConnectorRecommender } from '../PgConnectorRecommender.js';

interface CapturedQuery {
  text: string;
  values?: unknown[];
}

function makePool(insertConflictsAfter = -1): {
  pool: Pool;
  queries: CapturedQuery[];
  } {
  const queries: CapturedQuery[] = [];
  let insertCallCount = 0;
  const fakeClient: Partial<PoolClient> = {
    query: ((text: string, values?: unknown[]): Promise<QueryResult> => {
      queries.push({ text, values });
      if (text.includes('INSERT INTO oweibo.tenant_connectors')) {
        insertCallCount += 1;
        const conflict = insertConflictsAfter >= 0 && insertCallCount > insertConflictsAfter;
        return Promise.resolve({
          rows: [],
          rowCount: conflict ? 0 : 1,
          command: 'INSERT',
          oid: 0,
          fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  const pool: Partial<Pool> = {
    connect: jest.fn().mockResolvedValue(fakeClient),
  };
  return { pool: pool as Pool, queries };
}

function entry(connectorId: string, recommendedFor: string[], applicableIndustries?: string[]): ConnectorCatalogEntry {
  return {
    connectorId,
    displayName: connectorId.charAt(0).toUpperCase() + connectorId.slice(1),
    category: 'source_control',
    description: `test ${connectorId}`,
    catalogVersion: '1',
    credentialSchema: { type: 'object', required: [], properties: {} },
    capabilities: [{
      capabilityId: 'noop',
      summary: 'noop',
      actionClass: 'read.external_api',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
    }],
    recommendedFor,
    certification: 'verified',
    certifiedFor: [],
    ...(applicableIndustries ? { applicableIndustries } : {}),
  };
}

describe('PgConnectorRecommender', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('returns recommendations matching the template slug', async () => {
    const registry = ConnectorRegistry.fromEntries([
      entry('github', ['nextjs-app']),
      entry('slack',  ['*']),
      entry('postgres', ['fintech-smb']),
    ]);
    const { pool } = makePool();
    const adapter = new PgConnectorRecommender(registry, pool);

    const out = await adapter.recommend(tenantId, 'nextjs-app');
    expect(out.map((r) => r.connectorId).sort()).toEqual(['github', 'slack']);
  });

  it('writes one tenant_connectors row per recommendation with status=recommended', async () => {
    const registry = ConnectorRegistry.fromEntries([entry('slack', ['*'])]);
    const { pool, queries } = makePool();
    const adapter = new PgConnectorRecommender(registry, pool);

    const result = await adapter.recommendWithCounts(tenantId, 'default');
    expect(result.inserted).toBe(1);
    expect(result.skippedExisting).toBe(0);

    const inserts = queries.filter((q) => q.text.includes('INSERT INTO oweibo.tenant_connectors'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain("'recommended'");
    expect(inserts[0]!.text).toContain('tenant_connectors_unique_instance');
    expect(inserts[0]!.text).toContain('DO NOTHING');
    expect(inserts[0]!.values).toEqual([
      tenantId,
      'slack',
      '1',
      'default',
      `oweibo/tenants/${tenantId}/connectors/slack/default`,
      expect.stringContaining('"templateSlug":"default"'),
    ]);
  });

  it('is idempotent: existing rows produce skippedExisting, not duplicates', async () => {
    const registry = ConnectorRegistry.fromEntries([
      entry('slack',  ['*']),
      entry('github', ['*']),
    ]);
    // First insert succeeds, second hits the unique constraint.
    const { pool } = makePool(/* insertConflictsAfter */ 1);
    const adapter = new PgConnectorRecommender(registry, pool);

    const result = await adapter.recommendWithCounts(tenantId, 'default');
    expect(result.inserted).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(result.recommendations).toHaveLength(2);
  });

  it('returns empty + writes zero rows when no recommendations match', async () => {
    const registry = ConnectorRegistry.fromEntries([
      entry('postgres', ['fintech-smb']),
    ]);
    const { pool, queries } = makePool();
    const adapter = new PgConnectorRecommender(registry, pool);

    const out = await adapter.recommend(tenantId, 'unrelated-template');
    expect(out).toHaveLength(0);
    expect(queries.filter((q) => q.text.includes('INSERT INTO oweibo.tenant_connectors'))).toHaveLength(0);
  });

  it('F.5 review: industry argument filters catalog entries that declare applicableIndustries', async () => {
    const registry = ConnectorRegistry.fromEntries([
      entry('stripe', ['*'], ['fintech']),
      entry('epic',   ['*'], ['healthcare']),
      entry('slack',  ['*']), // industry-agnostic
    ]);
    const { pool, queries } = makePool();
    const adapter = new PgConnectorRecommender(registry, pool);

    const out = await adapter.recommend(tenantId, 'default', 'fintech');
    expect(out.map((r) => r.connectorId).sort()).toEqual(['slack', 'stripe']);

    const insertedConnectorIds = queries
      .filter((q) => q.text.includes('INSERT INTO oweibo.tenant_connectors'))
      .map((q) => (q.values as unknown[])[1]);
    expect(insertedConnectorIds.sort()).toEqual(['slack', 'stripe']);
    // Industry preserved in the connector's metadata for audit.
    const insertWithIndustry = queries.find((q) =>
      q.text.includes('INSERT INTO oweibo.tenant_connectors')
      && String((q.values as unknown[])[1]) === 'stripe');
    expect(String((insertWithIndustry!.values as unknown[])[5])).toContain('"industry":"fintech"');
  });

  it('sets app.tenant_id GUC inside the transaction for RLS', async () => {
    const registry = ConnectorRegistry.fromEntries([entry('slack', ['*'])]);
    const { pool, queries } = makePool();
    const adapter = new PgConnectorRecommender(registry, pool);
    await adapter.recommend(tenantId, 'default');

    const guc = queries.find((q) => q.text.includes(`SET LOCAL app.tenant_id`));
    expect(guc).toBeDefined();
    expect(guc!.text).toContain(tenantId);
  });
});
