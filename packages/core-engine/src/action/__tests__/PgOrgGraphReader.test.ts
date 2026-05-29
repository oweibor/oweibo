/**
 * Unit tests for PgOrgGraphReader.
 *
 * Verifies the org_nodes/org_edges joins, the 42P01 fall-through that
 * downgrades to fromGraph=false until tenant_action_approver_routing
 * ships (T.2.h), tenant scoping via SET LOCAL app.tenant_id, malformed-
 * tenantId guard, and the reports_to single-level walk.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PgOrgGraphReader } from '../PgOrgGraphReader.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const NODE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NODE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NODE_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_1 = 'ffffffff-ffff-ffff-ffff-ffffffff0001';
const USER_2 = 'ffffffff-ffff-ffff-ffff-ffffffff0002';

interface QueryStub {
  match: string;
  rows: Record<string, unknown>[];
  /** When set, throw this error (with `.code` matching) instead of returning rows. */
  throws?: Error & { code?: string };
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

describe('PgOrgGraphReader.resolveApprovers', () => {
  it('returns fromGraph=false when tenantId is malformed (no DB call)', async () => {
    const { pool, calls } = makePool([]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.resolveApprovers('not-a-uuid', 'deploy.prod.kube');
    expect(result).toEqual({ nodes: [], users: [], fromGraph: false });
    expect(calls.length).toBe(0);
  });

  it('returns fromGraph=false when no routing rows exist for the tenant+class', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_action_approver_routing', rows: [] },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.resolveApprovers(TENANT, 'deploy.prod.kube');
    expect(result).toEqual({ nodes: [], users: [], fromGraph: false });
  });

  it('returns the joined node + user set when routing rows match', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_action_approver_routing',
        rows: [
          { node_id: NODE_A, user_id: USER_1 },
          { node_id: NODE_B, user_id: USER_2 },
        ],
      },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.resolveApprovers(TENANT, 'deploy.prod.kube');
    expect(result.fromGraph).toBe(true);
    expect([...result.nodes].sort()).toEqual([NODE_A, NODE_B].sort());
    expect([...result.users].sort()).toEqual([USER_1, USER_2].sort());
  });

  it('downgrades to fromGraph=false when the routing table does not yet exist (42P01)', async () => {
    const err = new Error('relation "oweibo.tenant_action_approver_routing" does not exist') as Error & { code: string };
    err.code = '42P01';
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_action_approver_routing', rows: [], throws: err },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.resolveApprovers(TENANT, 'deploy.prod.kube');
    expect(result).toEqual({ nodes: [], users: [], fromGraph: false });
  });

  it('propagates non-42P01 DB errors', async () => {
    const err = new Error('boom') as Error & { code?: string };
    err.code = '23505';
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_action_approver_routing', rows: [], throws: err },
    ]);
    const r = new PgOrgGraphReader(pool);
    await expect(r.resolveApprovers(TENANT, 'deploy.prod.kube')).rejects.toThrow(/boom/);
  });

  it('returns fromGraph=true with empty users when nodes resolve but none have user_id', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_action_approver_routing',
        rows: [{ node_id: NODE_A, user_id: null }],
      },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.resolveApprovers(TENANT, 'deploy.prod.kube');
    expect(result).toEqual({ nodes: [NODE_A], users: [], fromGraph: true });
  });

  it('dedupes nodes and users in the result', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.tenant_action_approver_routing',
        rows: [
          { node_id: NODE_A, user_id: USER_1 },
          { node_id: NODE_A, user_id: USER_1 },  // duplicate
        ],
      },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.resolveApprovers(TENANT, 'deploy.prod.kube');
    expect(result.nodes).toEqual([NODE_A]);
    expect(result.users).toEqual([USER_1]);
  });

  it('runs the query inside a transaction with SET LOCAL app.tenant_id', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_action_approver_routing', rows: [] },
    ]);
    const r = new PgOrgGraphReader(pool);
    await r.resolveApprovers(TENANT, 'deploy.prod.kube');
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT}'`))).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });
});

describe('PgOrgGraphReader.reportsTo', () => {
  it('returns empty when tenantId is malformed (no DB call)', async () => {
    const { pool, calls } = makePool([]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.reportsTo('not-a-uuid', [NODE_A]);
    expect(result).toEqual({ nodes: [], users: [] });
    expect(calls.length).toBe(0);
  });

  it('returns empty when no nodeIds are passed (no DB call)', async () => {
    const { pool, calls } = makePool([]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.reportsTo(TENANT, []);
    expect(result).toEqual({ nodes: [], users: [] });
    expect(calls.length).toBe(0);
  });

  it('walks one level up via org_edges WHERE edge_type=reports_to', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.org_nodes n',
        rows: [
          { id: NODE_B, user_id: USER_2 },
          { id: NODE_C, user_id: null },
        ],
      },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.reportsTo(TENANT, [NODE_A]);
    expect([...result.nodes].sort()).toEqual([NODE_B, NODE_C].sort());
    expect(result.users).toEqual([USER_2]);
    const sql = calls.find(c => c.sql.includes('FROM oweibo.org_nodes n'))!.sql;
    expect(sql).toMatch(/edge_type\s*=\s*'reports_to'/);
    expect(sql).toMatch(/e\.from_node\s*=\s*ANY\(\$2::uuid\[\]\)/);
  });

  it('dedupes overlapping reports_to targets', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.org_nodes n',
        rows: [
          { id: NODE_B, user_id: USER_1 },
          { id: NODE_B, user_id: USER_1 },  // duplicate
        ],
      },
    ]);
    const r = new PgOrgGraphReader(pool);
    const result = await r.reportsTo(TENANT, [NODE_A, NODE_C]);
    expect(result.nodes).toEqual([NODE_B]);
    expect(result.users).toEqual([USER_1]);
  });

  it('runs the walk inside a tenant-scoped transaction', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.org_nodes n', rows: [] },
    ]);
    const r = new PgOrgGraphReader(pool);
    await r.reportsTo(TENANT, [NODE_A]);
    expect(calls.some(c => c.sql === 'BEGIN')).toBe(true);
    expect(calls.some(c => c.sql.includes(`SET LOCAL app.tenant_id = '${TENANT}'`))).toBe(true);
    expect(calls.some(c => c.sql === 'COMMIT')).toBe(true);
  });
});
