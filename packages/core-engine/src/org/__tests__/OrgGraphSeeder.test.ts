/**
 * T.2.h — OrgGraphSeeder tests. Mocks OrgGraphService at the method level.
 */
import { OrgGraphSeeder, DEFAULT_COUNCIL_APPROVED_CLASSES } from '../OrgGraphSeeder.js';
import type { OrgGraphService } from '../OrgGraphService.js';
import type { OrgEdge, OrgNode } from '@oweibo/core-contracts';

function nodeStub(id: string, nodeType: OrgNode['nodeType'], label: string, userId: string | null = null): OrgNode {
  return {
    id, tenantId: 't', nodeType, label, userId, externalRef: null,
    metadata: {}, createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
  };
}

function edgeStub(id: string, fromNode: string, toNode: string, edgeType: OrgEdge['edgeType']): OrgEdge {
  return {
    id, tenantId: 't', fromNode, toNode, edgeType, metadata: {}, createdAt: '2026-05-22T00:00:00Z',
  };
}

function fakeService(initialNodes: OrgNode[] = []): { svc: OrgGraphService; nodes: OrgNode[]; edges: OrgEdge[] } {
  const nodes = [...initialNodes];
  const edges: OrgEdge[] = [];
  let counter = 0;
  const svc = {
    listNodes: jest.fn().mockImplementation(async () => nodes),
    createNode: jest.fn().mockImplementation(async (input) => {
      const node = nodeStub(`n-${++counter}`, input.nodeType, input.label, input.userId ?? null);
      nodes.push(node);
      return node;
    }),
    createEdge: jest.fn().mockImplementation(async (input) => {
      const edge = edgeStub(`e-${++counter}`, input.fromNode, input.toNode, input.edgeType);
      edges.push(edge);
      return edge;
    }),
  } as unknown as OrgGraphService;
  return { svc, nodes, edges };
}

describe('OrgGraphSeeder.seed', () => {
  it('creates creator + admin team + council + edges on a fresh tenant', async () => {
    const { svc, nodes, edges } = fakeService();
    const seeder = new OrgGraphSeeder(svc);
    const result = await seeder.seed({ tenantId: 't', creatorUserId: 'user-1' });

    expect(result.nodesCreated).toBe(3);
    expect(result.edgesCreated).toBe(3);
    expect(result.creatorNodeId).not.toBeNull();
    expect(result.adminTeamNodeId).toBeTruthy();
    expect(result.councilNodeId).toBeTruthy();

    expect(nodes.find((n) => n.nodeType === 'person' && n.userId === 'user-1')).toBeDefined();
    expect(nodes.find((n) => n.nodeType === 'team' && n.label === 'Tenant Admins')).toBeDefined();
    expect(nodes.find((n) => n.nodeType === 'decision_body' && n.label === 'Tenant Admin Council')).toBeDefined();

    const approveEdge = edges.find((e) => e.edgeType === 'approves');
    expect(approveEdge).toBeDefined();
    expect(edges.filter((e) => e.edgeType === 'member_of')).toHaveLength(2);
  });

  it('skips the creator person node when creatorUserId is null', async () => {
    const { svc, nodes } = fakeService();
    const seeder = new OrgGraphSeeder(svc);
    const result = await seeder.seed({ tenantId: 't', creatorUserId: null });
    expect(result.creatorNodeId).toBeNull();
    expect(nodes.filter((n) => n.nodeType === 'person')).toHaveLength(0);
  });

  it('is idempotent: re-running on an already-seeded tenant creates 0 nodes', async () => {
    const existing: OrgNode[] = [
      nodeStub('p1', 'person', 'Tenant Creator', 'user-1'),
      nodeStub('t1', 'team', 'Tenant Admins'),
      nodeStub('c1', 'decision_body', 'Tenant Admin Council'),
    ];
    const { svc } = fakeService(existing);
    const seeder = new OrgGraphSeeder(svc);
    const result = await seeder.seed({ tenantId: 't', creatorUserId: 'user-1' });
    expect(result.nodesCreated).toBe(0);
    expect(svc.createNode).not.toHaveBeenCalled();
  });

  it('honors a custom approvedClasses override', async () => {
    const { svc, edges } = fakeService();
    const seeder = new OrgGraphSeeder(svc);
    await seeder.seed({
      tenantId: 't', creatorUserId: 'user-1',
      approvedClasses: ['comm.external_email'],
    });
    expect(edges.some((e) => e.edgeType === 'approves')).toBe(true);
    expect(svc.createEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeType: 'approves',
        metadata: { actionClasses: ['comm.external_email'] },
      }),
    );
  });

  it('ships a non-trivial default approved-class set covering financial/irreversible/personnel', () => {
    expect(DEFAULT_COUNCIL_APPROVED_CLASSES).toEqual(expect.arrayContaining([
      'financial.payment',
      'irreversible.delete_resource',
      'personnel.access_grant',
    ]));
  });
});
