/**
 * T.2.h — OrgGraphService tests. Pool-mocked; verifies the SQL semantics
 * of resolveApprovers + the row mapping for the simpler CRUD paths.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { OrgGraphService } from '../OrgGraphService.js';

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
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('OrgGraphService.createNode', () => {
  it('inserts and returns the new node', async () => {
    const { pool } = makePool([
      {
        match: 'INSERT INTO oweibo.org_nodes',
        rows: [{
          id: 'n1', tenant_id: TENANT_ID, node_type: 'team', label: 'Engineers',
          user_id: null, external_ref: null, metadata: {}, created_at: '2026-05-22T00:00:00Z', updated_at: '2026-05-22T00:00:00Z',
        }],
      },
    ]);
    const svc = new OrgGraphService(pool);
    const node = await svc.createNode({ tenantId: TENANT_ID, nodeType: 'team', label: 'Engineers' });
    expect(node.id).toBe('n1');
    expect(node.nodeType).toBe('team');
  });
});

describe('OrgGraphService.createEdge', () => {
  it('upserts the edge and returns it', async () => {
    const { pool, calls } = makePool([
      {
        match: 'INSERT INTO oweibo.org_edges',
        rows: [{
          id: 'e1', tenant_id: TENANT_ID, from_node: 'a', to_node: 'b',
          edge_type: 'member_of', metadata: {}, created_at: '2026-05-22T00:00:00Z',
        }],
      },
    ]);
    const svc = new OrgGraphService(pool);
    const e = await svc.createEdge({ tenantId: TENANT_ID, fromNode: 'a', toNode: 'b', edgeType: 'member_of' });
    expect(e.edgeType).toBe('member_of');
    const ins = calls.find((c) => c.sql.includes('INSERT INTO oweibo.org_edges'));
    expect(ins?.sql).toMatch(/ON CONFLICT/);
  });
});

describe('OrgGraphService.resolveApprovers', () => {
  it('returns fromGraph:false when no decision_body matches', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.org_nodes n', rows: [] },
    ]);
    const svc = new OrgGraphService(pool);
    const out = await svc.resolveApprovers(TENANT_ID, 'financial.payment');
    expect(out.fromGraph).toBe(false);
    expect(out.nodes).toEqual([]);
    expect(out.users).toEqual([]);
  });

  it('matches when metadata.actionClasses includes the requested class', async () => {
    const queries: Record<string, QueryResultRow[]> = {};
    queries['JOIN oweibo.org_edges e\n             ON e.tenant_id = n.tenant_id'] = [
      { id: 'council', metadata: { actionClasses: ['financial.payment', 'irreversible.delete_resource'] } },
    ];
    // Members query — keyed on member_of join.
    const memberQuery: QueryStub = {
      match: "AND e.edge_type = 'member_of'",
      rows: [
        { id: 'creator', user_id: 'user-1' },
        { id: 'someone', user_id: null },
      ],
    };
    const bodyQuery: QueryStub = {
      match: 'FROM oweibo.org_nodes n',
      rows: [{ id: 'council', metadata: { actionClasses: ['financial.payment'] } }],
    };
    const { pool } = makePool([memberQuery, bodyQuery]);
    const svc = new OrgGraphService(pool);
    const out = await svc.resolveApprovers(TENANT_ID, 'financial.payment');
    expect(out.fromGraph).toBe(true);
    expect(out.nodes).toEqual(expect.arrayContaining(['creator', 'someone']));
    expect(out.users).toEqual(['user-1']);
  });

  it('matches when metadata.actionClasses contains the wildcard "*"', async () => {
    const memberQuery: QueryStub = {
      match: "AND e.edge_type = 'member_of'",
      rows: [{ id: 'a', user_id: 'u-a' }],
    };
    const bodyQuery: QueryStub = {
      match: 'FROM oweibo.org_nodes n',
      rows: [{ id: 'council', metadata: { actionClasses: ['*'] } }],
    };
    const { pool } = makePool([memberQuery, bodyQuery]);
    const svc = new OrgGraphService(pool);
    const out = await svc.resolveApprovers(TENANT_ID, 'irreversible.delete_resource');
    expect(out.fromGraph).toBe(true);
    expect(out.users).toEqual(['u-a']);
  });

  it('returns fromGraph:false when bodies exist but none has matching classes', async () => {
    const bodyQuery: QueryStub = {
      match: 'FROM oweibo.org_nodes n',
      rows: [{ id: 'council', metadata: { actionClasses: ['comm.internal'] } }],
    };
    const { pool } = makePool([bodyQuery]);
    const svc = new OrgGraphService(pool);
    const out = await svc.resolveApprovers(TENANT_ID, 'financial.payment');
    expect(out.fromGraph).toBe(false);
  });
});

describe('OrgGraphService.setStakeholderInterest', () => {
  it('rejects weight out of [0,1] range', async () => {
    const { pool } = makePool([]);
    const svc = new OrgGraphService(pool);
    await expect(svc.setStakeholderInterest(TENANT_ID, 'n', 'finance', 1.5)).rejects.toThrow(RangeError);
    await expect(svc.setStakeholderInterest(TENANT_ID, 'n', 'finance', -0.1)).rejects.toThrow(RangeError);
  });

  it('upserts and returns the interest row', async () => {
    const { pool } = makePool([
      {
        match: 'INSERT INTO oweibo.org_stakeholder_interests',
        rows: [{ id: 'i1', tenant_id: TENANT_ID, node_id: 'n', domain: 'finance', weight: '0.75' }],
      },
    ]);
    const svc = new OrgGraphService(pool);
    const out = await svc.setStakeholderInterest(TENANT_ID, 'n', 'finance', 0.75);
    expect(out.weight).toBe(0.75);
  });
});
