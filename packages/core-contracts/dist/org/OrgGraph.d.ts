/**
 * T.2.h: org-graph contracts.
 *
 * The org graph is a tenant-scoped directed graph capturing organisational
 * structure: who's in the org, what teams exist, who approves what, who
 * cares about what domains. Used by T.−1 require_approval routing and by
 * future alignment-scoring flows.
 *
 * Primitives are deliberately minimal — the design avoids becoming a full
 * HRIS or enterprise architecture tool. The goal is the *cognitive anchor*.
 */
export type OrgNodeType = 'person' | 'team' | 'system' | 'decision_body' | 'external_party';
export type OrgEdgeType = 'reports_to' | 'owns' | 'approves' | 'depends_on' | 'member_of' | 'accountable_for';
export type OrgFactSource = 'admin_declared' | 'intake_inferred' | 'connector_sync' | 'organic_inferred';
export interface OrgNode {
    readonly id: string;
    readonly tenantId: string;
    readonly nodeType: OrgNodeType;
    readonly label: string;
    /** Bound platform user when nodeType === 'person'. */
    readonly userId: string | null;
    /** External reference (GitHub team slug, Slack channel id, …). */
    readonly externalRef: string | null;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface OrgEdge {
    readonly id: string;
    readonly tenantId: string;
    readonly fromNode: string;
    readonly toNode: string;
    readonly edgeType: OrgEdgeType;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
}
export interface OrgFact {
    readonly id: string;
    readonly tenantId: string;
    readonly nodeId: string;
    readonly factKey: string;
    readonly factValue: string;
    readonly source: OrgFactSource;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface OrgStakeholderInterest {
    readonly id: string;
    readonly tenantId: string;
    readonly nodeId: string;
    readonly domain: string;
    /** 0..1 strength of interest. */
    readonly weight: number;
}
/** Approver resolution result returned by IOrgGraphService.resolveApprovers. */
export interface ApproverResolution {
    /** Node ids authorised to approve. */
    readonly nodes: readonly string[];
    /** Bound user ids (for person nodes); may be a subset of nodes. */
    readonly users: readonly string[];
    /** True when a decision_body matched; false means fallback. */
    readonly fromGraph: boolean;
}
//# sourceMappingURL=OrgGraph.d.ts.map