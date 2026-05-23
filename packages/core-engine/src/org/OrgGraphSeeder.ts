/**
 * T.2.h: OrgGraphSeeder — installs the minimal day-one graph for a new
 * tenant.
 *
 * Seeds:
 *   1. a 'person' node bound to the creating user (if known)
 *   2. a 'team' node "Tenant Admins" with the creator as member_of
 *   3. a 'decision_body' node "Tenant Admin Council" with 'approves'
 *      edges typed for the always-require-approval action classes from
 *      T.−1 (financial.*, personnel.*, irreversible.*, deploy.prod,
 *      write.tenant_db.prod, write.local.repo_prod, comm.external_*,
 *      write.external_api.prod).
 *
 * Idempotent: re-seeding the same tenant is safe — node lookups by label
 * short-circuit and edge upserts have unique conflict targets.
 */
import type { OrgGraphService } from './OrgGraphService.js';

/** Default set of action classes the Tenant Admin Council approves. */
export const DEFAULT_COUNCIL_APPROVED_CLASSES: readonly string[] = [
  'financial.payment',
  'personnel.access_grant',
  'personnel.access_revoke',
  'irreversible.delete_resource',
  'irreversible.public_publish',
  'deploy.prod',
  'write.tenant_db.prod',
  'write.local.repo_prod',
  'write.external_api.prod',
  'comm.external_email',
  'comm.external_message',
];

export interface SeederInput {
  readonly tenantId: string;
  /** Creator user id; when null the person node is not created. */
  readonly creatorUserId: string | null;
  /** Optional override of the approved class set. */
  readonly approvedClasses?: readonly string[];
}

export interface SeederResult {
  readonly creatorNodeId: string | null;
  readonly adminTeamNodeId: string;
  readonly councilNodeId: string;
  readonly nodesCreated: number;
  readonly edgesCreated: number;
}

export class OrgGraphSeeder {
  constructor(private readonly service: OrgGraphService) {}

  async seed(input: SeederInput): Promise<SeederResult> {
    const approved = input.approvedClasses ?? DEFAULT_COUNCIL_APPROVED_CLASSES;
    const existingNodes = await this.service.listNodes(input.tenantId);
    const nodeByLabel = new Map(existingNodes.map((n) => [labelKey(n.nodeType, n.label), n.id]));

    let nodesCreated = 0;
    let edgesCreated = 0;

    // 1. Creator person node.
    let creatorNodeId: string | null = null;
    if (input.creatorUserId) {
      const existing = existingNodes.find((n) => n.nodeType === 'person' && n.userId === input.creatorUserId);
      if (existing) {
        creatorNodeId = existing.id;
      } else {
        const created = await this.service.createNode({
          tenantId: input.tenantId,
          nodeType: 'person',
          label: 'Tenant Creator',
          userId: input.creatorUserId,
        });
        creatorNodeId = created.id;
        nodesCreated += 1;
      }
    }

    // 2. Admin team node.
    const adminTeamKey = labelKey('team', 'Tenant Admins');
    let adminTeamNodeId = nodeByLabel.get(adminTeamKey) ?? null;
    if (!adminTeamNodeId) {
      const created = await this.service.createNode({
        tenantId: input.tenantId,
        nodeType: 'team',
        label: 'Tenant Admins',
      });
      adminTeamNodeId = created.id;
      nodesCreated += 1;
    }

    // 3. Decision body.
    const councilKey = labelKey('decision_body', 'Tenant Admin Council');
    let councilNodeId = nodeByLabel.get(councilKey) ?? null;
    if (!councilNodeId) {
      const created = await this.service.createNode({
        tenantId: input.tenantId,
        nodeType: 'decision_body',
        label: 'Tenant Admin Council',
      });
      councilNodeId = created.id;
      nodesCreated += 1;
    }

    // 4. Edges.
    // member_of: creator → admin team
    if (creatorNodeId) {
      await this.service.createEdge({
        tenantId: input.tenantId,
        fromNode: creatorNodeId,
        toNode: adminTeamNodeId,
        edgeType: 'member_of',
      });
      edgesCreated += 1;
      // member_of: creator → council (so the creator is a default approver)
      await this.service.createEdge({
        tenantId: input.tenantId,
        fromNode: creatorNodeId,
        toNode: councilNodeId,
        edgeType: 'member_of',
      });
      edgesCreated += 1;
    }
    // approves: council → council (self-referential carrier of the action-class list)
    await this.service.createEdge({
      tenantId: input.tenantId,
      fromNode: councilNodeId,
      toNode: councilNodeId,
      edgeType: 'approves',
      metadata: { actionClasses: approved },
    });
    edgesCreated += 1;

    return {
      creatorNodeId,
      adminTeamNodeId,
      councilNodeId,
      nodesCreated,
      edgesCreated,
    };
  }
}

function labelKey(nodeType: string, label: string): string {
  return `${nodeType}:${label.toLowerCase()}`;
}
