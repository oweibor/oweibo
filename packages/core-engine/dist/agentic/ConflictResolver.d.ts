import type { AgentMessage, ISecurityContext } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import type { HITLGateway } from '../governance/HITLGateway.js';
export interface ConflictResolution {
    accepted: boolean;
    acceptedOutput: unknown;
    messages: AgentMessage[];
}
/**
 * ConflictResolver — mediates between executor and reviewer when a challenge is raised.
 * If resolution cannot be reached, escalates to HITLGateway.
 */
export declare class ConflictResolver {
    private readonly hitl;
    constructor(hitl: HITLGateway);
    resolve(taskId: string, executorMsg: AgentMessage, reviewerMsg: AgentMessage, secCtx: ISecurityContext, trace: LangfuseTraceClient): Promise<ConflictResolution>;
}
//# sourceMappingURL=ConflictResolver.d.ts.map