import type { AgentMessage, ISubGoal, Plan, ISecurityContext, IAgentTask } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import type { Pool } from 'pg';
import { CohortRouter } from '../infrastructure/CohortRouter.js';
import type { CanonicalRole } from '@oweibo/core-contracts';
import { ConflictResolver } from './ConflictResolver.js';
import type { ISemanticMemoryStore } from '@oweibo/core-contracts';
import type { PolicyEngine } from '../governance/PolicyEngine.js';
import type { AnomalyDetector } from '../observability/AnomalyDetector.js';
import type { ImmutableAuditLogger } from '../governance/ImmutableAuditLogger.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { TaskInterventionGateway } from '../ingestion/TaskInterventionGateway.js';
import type { GoalDecomposer } from './GoalDecomposer.js';
import type { DistributedContextStore } from './DistributedContextStore.js';
import type { SessionStore } from '../ingestion/SessionStore.js';
import type { ArtifactFile } from './DocumentationAgent.js';
import type { ProductionSafetyChecker } from '../safety/ProductionSafetyChecker.js';
import type { CohortAdminService } from '../infrastructure/CohortAdminService.js';
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
    private readonly pgPool?;
    private readonly cohortRouter?;
    /** D.7: optional production safety checker — fires on 5% sample of executor output. */
    private readonly safetyChecker?;
    /** D.1: optional cohort admin — resolves per-tenant cohort_channel from tenant_settings. */
    private readonly cohortAdmin?;
    private readonly conflictResolver;
    constructor(baseLlm: {
        baseUrl: string;
        model: string;
    }, memory: ISemanticMemoryStore, policy: PolicyEngine, anomaly: AnomalyDetector, auditLogger: ImmutableAuditLogger, conflictResolver: ConflictResolver, eventBus: TaskEventBus, interventionGateway: TaskInterventionGateway, decomposer: GoalDecomposer, contextStore: DistributedContextStore, sessions: SessionStore, pgPool?: Pool | undefined, cohortRouter?: CohortRouter | undefined, 
    /** D.7: optional production safety checker — fires on 5% sample of executor output. */
    safetyChecker?: ProductionSafetyChecker | undefined, 
    /** D.1: optional cohort admin — resolves per-tenant cohort_channel from tenant_settings. */
    cohortAdmin?: CohortAdminService | undefined);
    /**
     * Entry point for CognitiveEngine (Phase A.4+).
     * Resolves prompts via CohortRouter, writes all assembled hashes atomically
     * with the task INSERT into oweibo.tasks, then runs the swarm.
     *
     * Invariant §2.3: hash columns and task INSERT are in the same Postgres transaction.
     */
    startTask(task: IAgentTask, plan: Plan, subGoals: ISubGoal[], secCtx: ISecurityContext, trace: LangfuseTraceClient, sessionId?: string): Promise<SwarmResult>;
    coordinate(taskId: string, tenantId: string, plan: Plan, subGoals: ISubGoal[], secCtx: ISecurityContext, trace: LangfuseTraceClient, sessionId?: string, agentPrompts?: Record<CanonicalRole, string>, resolvedMeta?: {
        channel: string;
        hashes: Record<CanonicalRole, string>;
    }): Promise<SwarmResult>;
    private executeSubGoal;
    private topologicalSort;
}
//# sourceMappingURL=SwarmCoordinator.d.ts.map