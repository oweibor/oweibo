/**
 * T.2.h: OrgGraphService — CRUD over the org-graph tables + approver
 * resolution used by T.−1's require_approval routing.
 *
 * resolveApprovers(tenantId, actionClass) walks the graph for any
 * decision_body node with an 'approves' edge whose metadata.actionClasses
 * includes the requested class (or '*'). It then collects every node
 * with a 'member_of' edge pointing at that body. If no such body exists,
 * `fromGraph: false` signals the caller to fall back to today's
 * tenant-admin role lookup — preserving backwards compatibility.
 *
 * All queries run under tenant RLS; the service expects the caller to
 * have set app.tenant_id (typically via withTenantContext upstream).
 */
import type { Pool } from 'pg';
import type { ApproverResolution, OrgEdge, OrgEdgeType, OrgFact, OrgFactSource, OrgNode, OrgNodeType, OrgStakeholderInterest } from '@oweibo/core-contracts';
export interface CreateNodeInput {
    readonly tenantId: string;
    readonly nodeType: OrgNodeType;
    readonly label: string;
    readonly userId?: string | null;
    readonly externalRef?: string | null;
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface CreateEdgeInput {
    readonly tenantId: string;
    readonly fromNode: string;
    readonly toNode: string;
    readonly edgeType: OrgEdgeType;
    readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface UpsertFactInput {
    readonly tenantId: string;
    readonly nodeId: string;
    readonly factKey: string;
    readonly factValue: string;
    readonly source: OrgFactSource;
}
export declare class OrgGraphService {
    private readonly pool;
    constructor(pool: Pool);
    createNode(input: CreateNodeInput): Promise<OrgNode>;
    listNodes(tenantId: string, opts?: {
        nodeType?: OrgNodeType;
    }): Promise<OrgNode[]>;
    createEdge(input: CreateEdgeInput): Promise<OrgEdge>;
    listEdges(tenantId: string, opts?: {
        fromNode?: string;
        edgeType?: OrgEdgeType;
    }): Promise<OrgEdge[]>;
    upsertFact(input: UpsertFactInput): Promise<OrgFact>;
    listFacts(tenantId: string, nodeId?: string): Promise<OrgFact[]>;
    setStakeholderInterest(tenantId: string, nodeId: string, domain: string, weight: number): Promise<OrgStakeholderInterest>;
    /**
     * Find every node authorised to approve actions of the given class. A
     * decision_body matches when it has an outgoing 'approves' edge whose
     * metadata.actionClasses includes the requested class or '*'. Members
     * of that body are collected via 'member_of' edges pointing at it.
     *
     * Returns { fromGraph: false } when no matching body exists, signalling
     * the caller to fall back to tenant-admin role lookup.
     */
    resolveApprovers(tenantId: string, actionClass: string): Promise<ApproverResolution>;
    private tx;
}
//# sourceMappingURL=OrgGraphService.d.ts.map