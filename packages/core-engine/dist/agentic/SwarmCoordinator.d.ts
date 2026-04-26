import type { AgentMessage, ISubGoal, Plan, ISecurityContext } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import { ConflictResolver } from './ConflictResolver.js';
import type { LongTermMemoryStore } from './LongTermMemoryStore.js';
import type { PolicyEngine } from '../governance/PolicyEngine.js';
import type { AnomalyDetector } from '../observability/AnomalyDetector.js';
import type { ImmutableAuditLogger } from '../governance/ImmutableAuditLogger.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { TaskInterventionGateway } from '../ingestion/TaskInterventionGateway.js';
import type { GoalDecomposer } from './GoalDecomposer.js';
import type { DistributedContextStore } from './DistributedContextStore.js';
import type { SessionStore } from '../ingestion/SessionStore.js';
import type { ArtifactFile } from './DocumentationAgent.js';
export interface SwarmResult {
    subGoalResults: Record<string, unknown>;
    agentMessages: AgentMessage[];
    tokensUsed: number;
    reviewPassed: boolean;
    docFiles: ArtifactFile[];
    docContext: unknown | null;
}
/**
 * SwarmCoordinator — dispatches sub-goals to specialist agents in parallel,
 * collects outputs, routes through ReviewerAgent, and resolves conflicts.
 *
 * v5: Checks TaskInterventionGateway at each sub-goal group boundary.
 * v7: Stamps lastSubGoalCompletedAt in DistributedContextStore after each group.
 * v9.1: DocFiles moved to DocGenerationStage (after SmokeTest).
 */
export declare class SwarmCoordinator {
    private readonly baseLlm;
    private readonly memory;
    private readonly policy;
    private readonly anomaly;
    private readonly auditLogger;
    private readonly eventBus;
    private readonly interventionGateway;
    private readonly decomposer;
    private readonly contextStore;
    private readonly sessions;
    private readonly conflictResolver;
    constructor(baseLlm: {
        baseUrl: string;
        model: string;
    }, memory: LongTermMemoryStore, policy: PolicyEngine, anomaly: AnomalyDetector, auditLogger: ImmutableAuditLogger, conflictResolver: ConflictResolver, eventBus: TaskEventBus, interventionGateway: TaskInterventionGateway, decomposer: GoalDecomposer, contextStore: DistributedContextStore, sessions: SessionStore);
    coordinate(taskId: string, tenantId: string, plan: Plan, subGoals: ISubGoal[], secCtx: ISecurityContext, trace: LangfuseTraceClient, sessionId?: string): Promise<SwarmResult>;
    private executeSubGoal;
    private topologicalSort;
}
//# sourceMappingURL=SwarmCoordinator.d.ts.map