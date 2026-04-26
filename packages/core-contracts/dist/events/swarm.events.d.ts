import type { AgentRole, AgentMessage } from '../types/AgentTypes.js';
/**
 * Swarm negotiation events — emitted on ScopedEventBus during multi-agent
 * coordination (NEW v4 §16d.5). All events carry a traceId for Langfuse correlation.
 */
export interface SwarmTaskAssignedEventV1 {
    readonly type: 'swarm:task.assigned';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly taskId: string;
        readonly subGoalId: string;
        readonly assignedToRole: AgentRole;
        readonly assignedToAgentId: string;
        readonly traceId: string;
        readonly assignedAt: string;
    };
}
export interface SwarmChallengeRaisedEventV1 {
    readonly type: 'swarm:challenge.raised';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly taskId: string;
        readonly challengerAgentId: string;
        readonly challengerRole: AgentRole;
        readonly challengedAgentId: string;
        readonly message: AgentMessage;
        readonly traceId: string;
        readonly raisedAt: string;
    };
}
export interface SwarmConsensusReachedEventV1 {
    readonly type: 'swarm:consensus.reached';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly taskId: string;
        readonly subGoalId: string;
        readonly participantAgentIds: readonly string[];
        readonly resolution: string;
        readonly traceId: string;
        readonly resolvedAt: string;
    };
}
export interface SwarmEscalatedToHITLEventV1 {
    readonly type: 'swarm:escalated.to.hitl';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly taskId: string;
        readonly subGoalId: string;
        readonly reason: string;
        readonly conflictSummary: string;
        readonly traceId: string;
        readonly escalatedAt: string;
    };
}
//# sourceMappingURL=swarm.events.d.ts.map