import type { IAgentTask, ISecurityContext } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import type { ConversationalLoop } from './ConversationalLoop.js';
import type { SynthesisAgent } from './SynthesisAgent.js';
import type { FileClassifier } from './FileClassifier.js';
import type { SpecialistAgentFactory } from './SpecialistAgentFactory.js';
import type { GeneralRepoIndexer } from './intelligence/GeneralRepoIndexer.js';
import type { RepoMapBuilder } from './intelligence/RepoMapBuilder.js';
import type { ProjectRulesLoader } from './project/ProjectRulesLoader.js';
import type { SkillRegistry } from './project/SkillRegistry.js';
import type { TaskEventBus } from '../ingestion/TaskEventBus.js';
import type { TaskInterventionGateway } from '../ingestion/TaskInterventionGateway.js';
import type { DistributedContextStore } from '../agentic/DistributedContextStore.js';
import type { WarmPoolManager } from '../sandbox/WarmPoolManager.js';
import type { VaultClient } from '../infrastructure/VaultClient.js';
export interface GeneralCodingResult {
    status: 'success' | 'failed' | 'partial';
    appliedEdits: string[];
    commitHash?: string;
    verificationPassed: boolean;
    tokensUsed: number;
}
/**
 * GeneralCodingOrchestrator — called by CognitiveEngine.processTask() when
 * task.taskMode === 'general-coding'.
 *
 * v9.5 — Reactive Executive model:
 *   1. Builds a DAG EditPlan via ConversationalLoop.planTurn().
 *   2. Subscribes to its own taskId channel on TaskEventBus.
 *   3. Dispatches all ready nodes (dependsOn satisfied) in parallel.
 *   4. On each 'plan-node-complete' event, re-evaluates the DAG:
 *      - Unlocks downstream nodes and dispatches them.
 *      - If a node result reveals new entangled files, amends the DAG and
 *        emits 'plan-amended' before dispatching the new nodes.
 *   5. Applies the partial-failure policy (≤30% retry; >30% task-failed).
 *   6. When all nodes are complete, hands off to SynthesisAgent and emits
 *      'synthesis-started'.
 *   7. Tears down the Redis subscriber in a finally block — no leak on error.
 *
 * v9.5.1 — Hierarchical Specialist Spawning (additive to v9.5):
 *   - maybeAmendDag() calls FileClassifier.classify() for every newly
 *     discovered file and stamps specialistRole on the amendment node.
 *   - dispatchNode() routes to SpecialistAgentFactory when specialistRole
 *     is set; emits 'specialist-spawned' BEFORE 'plan-node-dispatched'.
 *   - Specialist agents run inside the same WarmPool sandbox with isolated
 *     Qdrant memory scope: '{role}:{taskId}'.
 *   - The orchestrator remains the sole owner of the DAG. Specialists are
 *     subordinate nodes — not autonomous agents.
 *
 * Simple plans (all nodes have dependsOn: []) dispatch fully in parallel from
 * step 3 — equivalent in wall-clock time to the old ConversationalLoop path
 * but now fully auditable at the node level.
 *
 * The factory pipeline (Kilo stages, PipelineOrchestrator) is never invoked
 * from this path. WarmPool IS used — all tool execution routes through sandbox.
 */
export declare class GeneralCodingOrchestrator {
    private readonly indexer;
    private readonly repoMap;
    private readonly rules;
    private readonly skills;
    private readonly loop;
    private readonly synthesizer;
    private readonly fileClassifier;
    private readonly specialistFactory;
    private readonly eventBus;
    private readonly interventions;
    private readonly contextStore;
    private readonly warmPool;
    private readonly vault;
    constructor(indexer: GeneralRepoIndexer, repoMap: RepoMapBuilder, rules: ProjectRulesLoader, skills: SkillRegistry, loop: ConversationalLoop, synthesizer: SynthesisAgent, fileClassifier: FileClassifier, // NEW v9.5.1
    specialistFactory: SpecialistAgentFactory, // NEW v9.5.1
    eventBus: TaskEventBus, interventions: TaskInterventionGateway, contextStore: DistributedContextStore, warmPool: WarmPoolManager, vault: VaultClient);
    handle(task: IAgentTask, secCtx: ISecurityContext, trace: LangfuseTraceClient, sessionId: string): Promise<GeneralCodingResult>;
    /**
     * runReactiveLoop — the core of the v9.5 reactive executive.
     *
     * Subscribes to this task's TaskEventBus channel and drives the DAG forward
     * on each 'plan-node-complete' event. All DAG mutations are persisted to
     * DistributedContextStore before the corresponding TaskEventBus event is
     * emitted — audit log is always ahead of in-memory state.
     */
    private runReactiveLoop;
    /**
     * maybeAmendDag — inspects a completed node's result for newly discovered
     * entangled files not in the original plan. If found, creates new nodes,
     * appends them to the DAG with `dependsOn: [node.id]`, persists, and
     * emits 'plan-amended'.
     *
     * v9.5.1: For each newly discovered file, FileClassifier.classify() is called
     * (zero LLM calls — pure pattern matching). If the file requires a specialist
     * role, the amendment node is stamped with `specialistRole` and
     * `specialistReason` before being added to the DAG. dispatchNode() will pick
     * this up and route through SpecialistAgentFactory automatically.
     *
     * This is the mid-flight replanning mechanism. It emits the audit event
     * AFTER persisting so the event log is always consistent with stored state.
     */
    private maybeAmendDag;
    /** Returns true if all of node's dependsOn are in status 'complete'. */
    private isReady;
    /** Persist the live DAG to DistributedContextStore for worker-restart resilience. */
    private persistDag;
    /** Sum of tokensUsed across all completed nodes. */
    private totalTokens;
    /**
     * stampSpecialistRoles — Gap 4 + Gap 10 fix.
     * Called as the `onPlanBuilt` callback in planTurn() BEFORE plan-ready is emitted.
     * Classifies every file in every initial plan node using the synchronous FileClassifier
     * (built-in rules only — tenant rules are not available here without async Vault access,
     * which is acceptable because tenant rules are a refinement of the defaults, not a
     * replacement; amendment nodes get full tenant-rule classification in maybeAmendDag()).
     *
     * Mutates plan.nodes in-place (plan is not yet persisted when this is called).
     */
    private stampSpecialistRoles;
    /**
     * appendSynthesisNode — Gap 9. Injects a terminal DAG node that runs after
     * every other node completes. Dispatching it flows through dispatchNode()
     * like any other node, keeping the orchestrator's single dispatch path.
     */
    private appendSynthesisNode;
    /**
     * dispatchSynthesisNode — Gap 9. Owns all contextStore I/O on behalf of
     * SynthesisAgent (which is isolated by the dep-cruiser rule and cannot touch
     * DistributedContextStore / TaskEventBus directly).
     *
     *   1. Emit `synthesis-started`.
     *   2. Detect file-level conflicts across the DAG's completed non-synth nodes.
     *   3. Load each conflicting file's per-node contents from contextStore.
     *   4. Delegate to SynthesisAgent.merge() for LLM merge + verification.
     *   5. Persist each resolved merge back to contextStore.
     */
    private dispatchSynthesisNode;
    /**
     * deriveSecureCollectionSuffix — v9.1 security fix for namespace injection.
     * HMAC-SHA256(key=tenantId, data=sessionId) binds the namespace to the tenant.
     */
    private deriveSecureCollectionSuffix;
}
//# sourceMappingURL=GeneralCodingOrchestrator.d.ts.map