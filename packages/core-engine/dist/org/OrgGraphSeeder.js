"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrgGraphSeeder = exports.DEFAULT_COUNCIL_APPROVED_CLASSES = void 0;
/** Default set of action classes the Tenant Admin Council approves. */
exports.DEFAULT_COUNCIL_APPROVED_CLASSES = [
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
class OrgGraphSeeder {
    service;
    constructor(service) {
        this.service = service;
    }
    async seed(input) {
        const approved = input.approvedClasses ?? exports.DEFAULT_COUNCIL_APPROVED_CLASSES;
        const existingNodes = await this.service.listNodes(input.tenantId);
        const nodeByLabel = new Map(existingNodes.map((n) => [labelKey(n.nodeType, n.label), n.id]));
        let nodesCreated = 0;
        let edgesCreated = 0;
        // 1. Creator person node.
        let creatorNodeId = null;
        if (input.creatorUserId) {
            const existing = existingNodes.find((n) => n.nodeType === 'person' && n.userId === input.creatorUserId);
            if (existing) {
                creatorNodeId = existing.id;
            }
            else {
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
exports.OrgGraphSeeder = OrgGraphSeeder;
function labelKey(nodeType, label) {
    return `${nodeType}:${label.toLowerCase()}`;
}
//# sourceMappingURL=OrgGraphSeeder.js.map