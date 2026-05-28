/**
 * S.0: ActionLineage — append-only audit tree linking every decision
 * upstream of an action execution.
 *
 * Used by S.3 (rollback finds the originating decision) and S.7
 * (forensic replay reconstructs the full tree). Lineage is never
 * mutated after write; the partitioned table sheds old months on a
 * rolling 180-day window.
 */
export type LineageNodeKind = 'goal_decomposition' | 'agent_decision' | 'tool_invocation' | 'gate_decision' | 'execution' | 'verification' | 'rollback';
export type LineageProducerType = 'agent' | 'gate' | 'human';
export interface ActionLineageNode {
    readonly nodeId: string;
    readonly planId: string;
    /** null = root decision (e.g. goal_decomposition kicking off the plan). */
    readonly parentNodeId: string | null;
    readonly kind: LineageNodeKind;
    readonly producer: {
        readonly type: LineageProducerType;
        readonly id: string;
    };
    readonly summary: string;
    /** Structured per-kind detail; consumers may type-narrow. */
    readonly detail: unknown;
    readonly recordedAt: string;
    /** Optional pointer to Langfuse / OTel trace. */
    readonly traceId?: string;
}
/**
 * Append-only writer surface. Implementations write into
 * `oweibo.action_lineage`; tenant scope is set by the caller via
 * `withTenantContext` before each write. Returns the generated nodeId.
 */
export interface ILineageRecorder {
    record(node: Omit<ActionLineageNode, 'nodeId' | 'recordedAt'> & {
        readonly tenantId: string;
    }): Promise<string>;
}
//# sourceMappingURL=ActionLineage.d.ts.map