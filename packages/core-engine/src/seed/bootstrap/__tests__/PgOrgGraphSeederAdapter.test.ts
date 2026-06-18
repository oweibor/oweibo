/**
 * F.5.4 — PgOrgGraphSeederAdapter tests.
 */
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { OrgGraphService } from '../../../org/OrgGraphService.js';
import { PgOrgGraphSeederAdapter } from '../PgOrgGraphSeederAdapter.js';

function makePool(
  adminMembership: { user_id: string } | null,
  anyMembership: { user_id: string } | null,
): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const client: Partial<PoolClient> = {
    query: ((text: string, _values?: unknown[]): Promise<QueryResult> => {
      queries.push(text);
      if (text.includes('roles && ARRAY')) {
        return Promise.resolve({
          rows: adminMembership ? [adminMembership] : [],
          rowCount: adminMembership ? 1 : 0, command: 'SELECT', oid: 0, fields: [],
        });
      }
      if (text.includes('tenant_memberships') && !text.includes('roles && ARRAY')) {
        return Promise.resolve({
          rows: anyMembership ? [anyMembership] : [],
          rowCount: anyMembership ? 1 : 0, command: 'SELECT', oid: 0, fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    }) as PoolClient['query'],
    release: jest.fn(),
  };
  return {
    pool: { connect: jest.fn().mockResolvedValue(client) } as Partial<Pool> as Pool,
    queries,
  };
}

function makeOrgService(): {
  service: OrgGraphService;
  createdNodes: { tenantId: string; nodeType: string; label: string; userId?: string }[];
  createdEdges: { tenantId: string; fromNode: string; toNode: string; edgeType: string }[];
  } {
  const createdNodes: { tenantId: string; nodeType: string; label: string; userId?: string }[] = [];
  const createdEdges: { tenantId: string; fromNode: string; toNode: string; edgeType: string }[] = [];
  let i = 0;
  const next = () => `node-${++i}`;
  const service: Partial<OrgGraphService> = {
    listNodes: jest.fn().mockResolvedValue([]),
    createNode: jest.fn().mockImplementation(async (input) => {
      createdNodes.push(input);
      return { id: next(), ...input };
    }) as OrgGraphService['createNode'],
    createEdge: jest.fn().mockImplementation(async (input) => {
      createdEdges.push(input);
      return { id: `edge-${createdEdges.length}` };
    }) as OrgGraphService['createEdge'],
  };
  return { service: service as OrgGraphService, createdNodes, createdEdges };
}

describe('PgOrgGraphSeederAdapter', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  it('uses the earliest tenant_admin as creator when one exists', async () => {
    const { pool } = makePool({ user_id: 'user-admin' }, { user_id: 'someone-else' });
    const { service, createdNodes } = makeOrgService();

    const adapter = new PgOrgGraphSeederAdapter(pool, service);
    const out = await adapter.seed(tenantId);

    const personNode = createdNodes.find((n) => n.nodeType === 'person');
    expect(personNode?.userId).toBe('user-admin');
    expect(out.creatorNodeId).not.toBeNull();
  });

  it('falls back to earliest membership when no admin role exists', async () => {
    const { pool } = makePool(null, { user_id: 'user-member' });
    const { service, createdNodes } = makeOrgService();

    const adapter = new PgOrgGraphSeederAdapter(pool, service);
    await adapter.seed(tenantId);

    const personNode = createdNodes.find((n) => n.nodeType === 'person');
    expect(personNode?.userId).toBe('user-member');
  });

  it('creates admin team + council with no creator when no members exist', async () => {
    const { pool } = makePool(null, null);
    const { service, createdNodes } = makeOrgService();

    const adapter = new PgOrgGraphSeederAdapter(pool, service);
    const out = await adapter.seed(tenantId);

    expect(out.creatorNodeId).toBeNull();
    expect(out.adminTeamNodeId).not.toBeNull();
    expect(out.councilNodeId).not.toBeNull();
    const labels = createdNodes.map((n) => n.label).sort();
    expect(labels).toEqual(['Tenant Admin Council', 'Tenant Admins']);
  });

  it('always creates the council approves-edge', async () => {
    const { pool } = makePool({ user_id: 'user-admin' }, null);
    const { service, createdEdges } = makeOrgService();

    const adapter = new PgOrgGraphSeederAdapter(pool, service);
    await adapter.seed(tenantId);

    const approves = createdEdges.find((e) => e.edgeType === 'approves');
    expect(approves).toBeDefined();
  });

  it('runs lookup inside a tx (BEGIN before SET LOCAL ROLE) so the role grant survives', async () => {
    const { pool, queries } = makePool({ user_id: 'user-admin' }, null);
    const { service } = makeOrgService();
    const adapter = new PgOrgGraphSeederAdapter(pool, service);
    await adapter.seed(tenantId);

    // The whole sequence must be: BEGIN -> SET LOCAL app.tenant_id -> SET LOCAL ROLE -> SELECTs -> COMMIT.
    // The prior implementation did SET LOCAL ROLE without BEGIN, which Postgres treats as a no-op.
    const beginIdx = queries.findIndex((q) => q === 'BEGIN');
    const setRoleIdx = queries.findIndex((q) => q.includes('SET LOCAL ROLE platform_admin'));
    const setTenantIdx = queries.findIndex((q) => q.includes('SET LOCAL app.tenant_id'));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(setTenantIdx).toBeGreaterThan(beginIdx);
    expect(setRoleIdx).toBeGreaterThan(beginIdx);
    expect(queries.find((q) => q === 'COMMIT')).toBeDefined();
  });
});
