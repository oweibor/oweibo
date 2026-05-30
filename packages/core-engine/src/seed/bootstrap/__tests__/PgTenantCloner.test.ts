/**
 * F.5.5 — PgTenantCloner tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgTenantCloner } from '../PgTenantCloner.js';

interface MockState {
  parentExists: boolean;
  projectsCopied: number;
  nodesCopied: number;
  edgesCopied: number;
  settingsCopied: number;
  connectorsCopied: number;
}

function makePool(state: MockState): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const client: Partial<PoolClient> = {
    query: ((text: string, _values?: unknown[]): Promise<QueryResult> => {
      queries.push(text);
      if (text.includes('SELECT EXISTS')) {
        return Promise.resolve({
          rows: [{ exists: state.parentExists }],
          rowCount: 1, command: 'SELECT', oid: 0, fields: [],
        });
      }
      if (text.includes('INSERT INTO oweibo.tenant_projects')) {
        return Promise.resolve({ rows: [], rowCount: state.projectsCopied, command: 'INSERT', oid: 0, fields: [] });
      }
      if (text.includes('WITH src AS') && text.includes('org_nodes')) {
        // copyOrgGraph node insert + map
        const rows = Array.from({ length: state.nodesCopied }, (_, i) => ({
          old_id: `old-${i}`, new_id: `new-${i}`,
        }));
        return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
      }
      if (text.includes('SELECT from_node, to_node')) {
        const rows = Array.from({ length: state.edgesCopied }, (_, i) => ({
          from_node: `old-${i % state.nodesCopied}`,
          to_node:   `old-${(i + 1) % state.nodesCopied}`,
          edge_type: 'member_of',
          metadata:  {},
        }));
        return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
      }
      if (text.includes('INSERT INTO oweibo.org_edges')) {
        return Promise.resolve({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });
      }
      if (text.includes('UPDATE oweibo.tenants')) {
        return Promise.resolve({ rows: [], rowCount: state.settingsCopied, command: 'UPDATE', oid: 0, fields: [] });
      }
      if (text.includes('INSERT INTO oweibo.tenant_connectors')) {
        return Promise.resolve({ rows: [], rowCount: state.connectorsCopied, command: 'INSERT', oid: 0, fields: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  return {
    pool: {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockImplementation((text: string, _values?: unknown[]) => {
        queries.push(text);
        if (text.includes('SELECT EXISTS')) {
          return Promise.resolve({
            rows: [{ exists: state.parentExists }],
            rowCount: 1, command: 'SELECT', oid: 0, fields: [],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      }) as Pool['query'],
    } as Partial<Pool> as Pool,
    queries,
  };
}

describe('PgTenantCloner', () => {
  const parent = '11111111-1111-1111-1111-111111111111';
  const child  = '22222222-2222-2222-2222-222222222222';

  it('returns parent_tenant_missing skips when parent row is gone', async () => {
    const { pool } = makePool({
      parentExists: false,
      projectsCopied: 0, nodesCopied: 0, edgesCopied: 0,
      settingsCopied: 0, connectorsCopied: 0,
    });
    const cloner = new PgTenantCloner(pool);

    const out = await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['projects', 'settings'] });
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.status === 'skipped' && r.error === 'parent_tenant_missing')).toBe(true);
  });

  it('copies projects via INSERT...SELECT with [from parent] prefix', async () => {
    const { pool, queries } = makePool({
      parentExists: true, projectsCopied: 3,
      nodesCopied: 0, edgesCopied: 0, settingsCopied: 0, connectorsCopied: 0,
    });
    const cloner = new PgTenantCloner(pool);

    const out = await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['projects'] });
    expect(out.results[0]!.status).toBe('ok');
    expect(out.results[0]!.copied).toBe(3);
    const insert = queries.find((q) => q.includes('INSERT INTO oweibo.tenant_projects'));
    expect(insert).toContain("'[from parent] '");
    expect(insert).toContain('tenant_projects_unique_starter');
  });

  it('clones org graph as shell nodes (user_id NULL)', async () => {
    const { pool, queries } = makePool({
      parentExists: true,
      projectsCopied: 0, nodesCopied: 2, edgesCopied: 1,
      settingsCopied: 0, connectorsCopied: 0,
    });
    const cloner = new PgTenantCloner(pool);

    const out = await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['org_graph'] });
    expect(out.results[0]!.status).toBe('ok');

    const nodeInsert = queries.find((q) => q.includes('WITH src AS') && q.includes('org_nodes'));
    expect(nodeInsert).toContain('NULL'); // user_id stripped
  });

  it('settings copy preserves child existing features (jsonb concat)', async () => {
    const { pool, queries } = makePool({
      parentExists: true, settingsCopied: 1,
      projectsCopied: 0, nodesCopied: 0, edgesCopied: 0, connectorsCopied: 0,
    });
    const cloner = new PgTenantCloner(pool);

    await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['settings'] });
    const update = queries.find((q) => q.includes('UPDATE oweibo.tenants'));
    expect(update).toContain('COALESCE(child.features');
    expect(update).toContain("parent.features - 'industry'"); // industry intentionally excluded
  });

  it('connectors_recommend rewrites vault_path to child namespace + status=recommended', async () => {
    const { pool, queries } = makePool({
      parentExists: true, connectorsCopied: 2,
      projectsCopied: 0, nodesCopied: 0, edgesCopied: 0, settingsCopied: 0,
    });
    const cloner = new PgTenantCloner(pool);

    await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['connectors_recommend'] });
    const insert = queries.find((q) => q.includes('INSERT INTO oweibo.tenant_connectors'));
    expect(insert).toContain("'recommended'");
    expect(insert).toContain("'clonedFromParent'");
  });

  it('memories scope skips by default (no Qdrant infra)', async () => {
    const { pool } = makePool({
      parentExists: true,
      projectsCopied: 0, nodesCopied: 0, edgesCopied: 0, settingsCopied: 0, connectorsCopied: 0,
    });
    const cloner = new PgTenantCloner(pool); // no copyMemories supplied

    const out = await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['memories'] });
    expect(out.results[0]!.status).toBe('skipped');
  });

  it('memories scope runs when copyMemories is wired', async () => {
    const { pool } = makePool({
      parentExists: true,
      projectsCopied: 0, nodesCopied: 0, edgesCopied: 0, settingsCopied: 0, connectorsCopied: 0,
    });
    const copyMemories = jest.fn().mockResolvedValue(42);
    const cloner = new PgTenantCloner(pool, { copyMemories });

    const out = await cloner.clone({ parentTenantId: parent, childTenantId: child, scopes: ['memories'] });
    expect(out.results[0]!.status).toBe('ok');
    expect(out.results[0]!.copied).toBe(42);
    expect(copyMemories).toHaveBeenCalledWith(parent, child);
  });
});
