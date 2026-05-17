import type { IAgentTask, ISecurityContext, AgentRole } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import type { GeneralCodingAgent } from './GeneralCodingAgent.js';
import type { EditPlanner } from './editing/EditPlanner.js';
import type { EditApplicator } from './editing/EditApplicator.js';
import type { VerificationRunner } from './editing/VerificationRunner.js';
import type { GeneralRepoIndexer } from './intelligence/GeneralRepoIndexer.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { TaskInterventionGateway } from '../ingestion/TaskInterventionGateway.js';
import type { SessionStore } from '../ingestion/SessionStore.js';
import type { DistributedContextStore } from '../agentic/DistributedContextStore.js';
import type { GeneralCodingResult } from './GeneralCodingOrchestrator.js';
import type { IMemoryOrchestrator } from '@oweibo/core-contracts';
import type { UserProfileStore } from '../agentic/UserProfileStore.js';
import type { PreferenceNudgeService } from '../agentic/PreferenceNudgeService.js';
import type { PromptBudgetEnforcer } from '../infrastructure/PromptBudgetEnforcer.js';
/**
 * EditPlanNode — one unit of work in the DAG EditPlan.
 *
 * `dependsOn` lists the `id`s of nodes that must reach status `'complete'`
 * before this node may be dispatched. An empty array means "no dependencies —
 * dispatch immediately."
 *
 * `assignedAgentId` is written by GeneralCodingOrchestrator when the node is
 * dispatched and stored in DistributedContextStore so worker restarts can
 * detect in-flight nodes and re-dispatch them.
 */
export interface EditPlanNode {
    id: string;
    files: string[];
    module: string;
    changeDescription: string;
    dependsOn: string[];
    status: 'pending' | 'dispatched' | 'complete' | 'failed';
    assignedAgentId?: string;
    result?: NodeResult;
    /**
     * specialistRole — v9.5.1: set by maybeAmendDag() when FileClassifier
     * identifies a newly discovered file as requiring a non-general-coder agent.
     *
     * When absent (undefined) or 'general-coder': dispatchNode() routes via
     * ConversationalLoop.runTurns() as before.
     *
     * When set to a specialist role: dispatchNode() calls
     * SpecialistAgentFactory.spawn() and emits 'specialist-spawned' before
     * 'plan-node-dispatched'. The orchestrator's DAG ownership is unchanged —
     * the specialist is a subordinate node, not an autonomous agent.
     */
    specialistRole?: AgentRole;
    /** Human-readable reason for specialist assignment — echoed in 'specialist-spawned' event */
    specialistReason?: string;
}
export interface NodeResult {
    appliedEdits: string[];
    commitHash?: string;
    verificationPassed: boolean;
    tokensUsed: number;
}
/**
 * EditPlan — DAG of EditPlanNodes.
 *
 * Replaces the v9 flat-list shape. The orchestrator traverses this graph,
 * dispatching all nodes whose dependsOn are satisfied in parallel.
 *
 * `instruction` and `estimatedComplexity` are preserved for backward
 * compatibility with plan-ready event consumers and CLI rendering.
 *
 * Migration from flat plans: `EditPlanner.plan()` now always returns this
 * shape. A plan with all nodes having `dependsOn: []` is equivalent to the
 * former flat list and is dispatched fully in parallel.
 */
export interface EditPlan {
    instruction: string;
    nodes: EditPlanNode[];
    estimatedComplexity: 'simple' | 'moderate' | 'complex';
    /** Convenience accessor — all unique files across all nodes */
    readonly filesToChange: string[];
    /** Convenience accessor — all unique modules across all nodes */
    readonly modulesAffected: string[];
}
export declare class ConversationalLoop {
    private readonly agent;
    private readonly planner;
    private readonly applicator;
    private readonly verifier;
    private readonly indexer;
    private readonly sessions;
    private readonly eventBus;
    private readonly interventions;
    private readonly contextStore;
    private readonly memoryOrchestrator;
    private readonly userProfileStore;
    private readonly preferenceNudge;
    private readonly budgetEnforcer;
    private static readonly MAX_VERIFY_ITERATIONS;
    constructor(agent: GeneralCodingAgent, planner: EditPlanner, applicator: EditApplicator, verifier: VerificationRunner, indexer: GeneralRepoIndexer, sessions: SessionStore, eventBus: TaskEventBus, interventions: TaskInterventionGateway, contextStore: DistributedContextStore, memoryOrchestrator: IMemoryOrchestrator, userProfileStore: UserProfileStore, preferenceNudge: PreferenceNudgeService, budgetEnforcer: PromptBudgetEnforcer);
    /**
     * planTurn — produces an EditPlan from the task goal without executing anything.
     * The plan is published as a 'plan-ready' event and execution is blocked until
     * the user approves via `oweibo approve <taskId>` (TaskInterventionGateway).
     *
     * G11: plan-before-execute surface — users see exactly what will change before it happens.
     *
     * Gap 4 + Gap 10 fix: `onPlanBuilt` optional callback is invoked AFTER EditPlanner
     * returns and BEFORE plan-ready is emitted. GeneralCodingOrchestrator.handle() passes
     * `stampSpecialistRoles()` here so that every initial DAG node has its `specialistRole`
     * set before the user sees the approval prompt. This is the minimal-change approach:
     * planTurn() remains the single place that emits plan-ready; the stamping is injected
     * from outside without touching EditPlanner's constructor or signature.
     */
    planTurn(task: IAgentTask, repoMapText: string, projectRules: string, skillsPrefix: string, // NEW v9.4 — after projectRules, before collectionName
    collectionName: string, secCtx: ISecurityContext, trace: LangfuseTraceClient, onPlanBuilt?: (plan: EditPlan) => void): Promise<EditPlan>;
    /**
     * runTurns — executes the approved EditPlan through the edit → verify → fix loop.
     * Persists turn state so a worker restart resumes from the correct iteration.
     */
    runTurns(task: IAgentTask, plan: EditPlan, repoMapText: string, projectRules: string, skillsPrefix: string, // NEW v9.4
    collectionName: string, secCtx: ISecurityContext, trace: LangfuseTraceClient, sessionId: string): Promise<GeneralCodingResult>;
    private readFiles;
}
//# sourceMappingURL=ConversationalLoop.d.ts.map