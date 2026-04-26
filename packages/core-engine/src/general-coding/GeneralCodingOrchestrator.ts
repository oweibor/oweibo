// packages/core-engine/src/general-coding/GeneralCodingOrchestrator.ts
// Reactive Executive — v9.5 (§16f.1)
import { createHmac } from 'crypto';
import type { IAgentTask, ISecurityContext, AgentRole } from '@oweibo/core-contracts';
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
import type { EditPlan, EditPlanNode, NodeResult } from './ConversationalLoop.js';
import type { VaultClient } from '../infrastructure/VaultClient.js';
import { assertRepoAccess } from '../infrastructure/assertRepoAccess.js';

/** Threshold above which a partial failure triggers full task-failed rather than retry. */
const FAILURE_BUDGET = 0.30;

export interface GeneralCodingResult {
  status:             'success' | 'failed' | 'partial';
  appliedEdits:       string[];
  commitHash?:        string;
  verificationPassed: boolean;
  tokensUsed:         number;
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
export class GeneralCodingOrchestrator {
  constructor(
    private readonly indexer:           GeneralRepoIndexer,
    private readonly repoMap:           RepoMapBuilder,
    private readonly rules:             ProjectRulesLoader,
    private readonly skills:            SkillRegistry,
    private readonly loop:              ConversationalLoop,
    private readonly synthesizer:       SynthesisAgent,
    private readonly fileClassifier:    FileClassifier,        // NEW v9.5.1
    private readonly specialistFactory: SpecialistAgentFactory, // NEW v9.5.1
    private readonly eventBus:          TaskEventBus,
    private readonly interventions:     TaskInterventionGateway,
    private readonly contextStore:      DistributedContextStore,
    private readonly warmPool:          WarmPoolManager,
    private readonly vault:             VaultClient,
  ) {}

  async handle(
    task:      IAgentTask,
    secCtx:    ISecurityContext,
    trace:     LangfuseTraceClient,
    sessionId: string,
  ): Promise<GeneralCodingResult> {
    if (!task.repoPath) throw new Error('[GeneralCodingOrchestrator] repoPath is required for general-coding tasks');

    // 1. Authorise repoPath against tenant's allowedRepoPaths in Vault (Phase 1.5 — shared primitive)
    await assertRepoAccess(this.vault, task.tenantId, task.repoPath, secCtx);

    // 2. Namespace injection guard (v9.1)
    const sanitizedSessionId = this.deriveSecureCollectionSuffix(task.tenantId, sessionId);
    const collectionName = `general-repo:${task.tenantId}:${sanitizedSessionId}`;

    const existingIndex = await this.contextStore.load(`gc-index:${task.tenantId}:${sanitizedSessionId}`);
    if (!existingIndex) {
      await this.indexer.index(task.repoPath, collectionName, task.tenantId);
      await this.contextStore.save({
        id: `gc-index:${task.tenantId}:${sanitizedSessionId}`,
        collectionName, repoPath: task.repoPath,
        tenantId: task.tenantId, indexedAt: Date.now(),
      });
      await this.eventBus.publish(sessionId, { taskId: task.id, type: 'index-ready', message: 'Codebase indexed. Building repo map…', progress: 15 });
    } else {
      if ((existingIndex as { tenantId?: string }).tenantId !== task.tenantId) {
        throw new Error(`[GeneralCodingOrchestrator] Tenant mismatch: index belongs to different tenant`);
      }
    }

    // 3. Build repo map, rules, skills
    const repoMapText  = await this.repoMap.build(task.repoPath);
    const projectRules = await this.rules.load(task.repoPath);
    const discoveredSkills = await this.skills.discoverCached(task.repoPath, task.tenantId);
    await this.skills.ensureEmbedded(discoveredSkills, task.tenantId, trace);
    const skillsPrefix = await this.skills.selectForTask(task.goal.description, discoveredSkills, task.tenantId, trace, 'general-coding');

    // 4. Produce DAG EditPlan — blocks until user approves via /approve <taskId>
    // Gap 4 + Gap 10 fix: stampSpecialistRoles() is passed as onPlanBuilt callback
    // so all nodes get specialistRole stamped BEFORE plan-ready is emitted.
    const plan = await this.loop.planTurn(
      task, repoMapText, projectRules, skillsPrefix, collectionName, secCtx, trace,
      (builtPlan) => this.stampSpecialistRoles(builtPlan),  // Gap 4 fix
    );

    // Gap 9: Append a terminal synthesis node that depends on every other node.
    // It is dispatched like any other DAG node — the orchestrator's dispatchNode()
    // branches into a synthesizer-specific path when specialistRole === 'synthesizer'.
    this.appendSynthesisNode(plan);

    // 5. Persist initial DAG state for worker-restart resilience
    await this.contextStore.save({ id: `gc-dag:${task.id}`, plan, status: 'running' });

    // 6. Run the reactive dispatch loop
    return await this.runReactiveLoop(task, plan, repoMapText, projectRules, skillsPrefix, collectionName, secCtx, trace, sessionId);
  }

  /**
   * runReactiveLoop — the core of the v9.5 reactive executive.
   *
   * Subscribes to this task's TaskEventBus channel and drives the DAG forward
   * on each 'plan-node-complete' event. All DAG mutations are persisted to
   * DistributedContextStore before the corresponding TaskEventBus event is
   * emitted — audit log is always ahead of in-memory state.
   */
  private async runReactiveLoop(
    task: IAgentTask,
    plan: EditPlan,
    repoMapText: string,
    projectRules: string,
    skillsPrefix: string,
    collectionName: string,
    secCtx: ISecurityContext,
    trace: LangfuseTraceClient,
    sessionId: string,
  ): Promise<GeneralCodingResult> {
    // Live mutable DAG — deep-cloned so the original plan object is not mutated
    const dag: EditPlanNode[] = plan.nodes.map(n => ({ ...n }));

    const dispatchNode = async (node: EditPlanNode): Promise<void> => {
      const span = trace.span({ name: `node-dispatch:${node.id}`, input: { nodeId: node.id, files: node.files, role: node.specialistRole ?? 'general-coder' } });
      node.status = 'dispatched';
      node.assignedAgentId = `agent:${node.id}`;
      await this.persistDag(task.id, dag);

      // v9.5.1: If a specialist role is required, spawn the agent and emit
      // 'specialist-spawned' BEFORE 'plan-node-dispatched'. Hierarchy is preserved:
      // the orchestrator still owns the DAG; the specialist is a subordinate node.
      //
      // Gap 9: 'synthesizer' is a DAG node role but is NOT a SpecialistAgentFactory
      // participant — it routes through dispatchSynthesisNode() below, skipping
      // spawn()/specialist-spawned emission.
      const isSpecialist = node.specialistRole
        && node.specialistRole !== 'general-coder'
        && node.specialistRole !== 'synthesizer';
      let specialistAgent: import('./SpecialistAgentFactory.js').SpecialistAgent | null = null;

      if (isSpecialist) {
        // Gap 5 fix: pass nodeId and isRestart so spawn() can enforce idempotent budget counting
        const isRestart = !!node.assignedAgentId;  // node already had an agent before crash
        specialistAgent = await this.specialistFactory.spawn(
          node.specialistRole!,
          task,
          node.id,      // Gap 5: nodeId for gc-spawn-node idempotency key
          secCtx,
          trace,
          isRestart,    // Gap 5: skip INCR on worker-restart re-dispatch
        );
        // Emit audit event BEFORE plan-node-dispatched so observers see role first
        await this.eventBus.publish(sessionId, {
          taskId: task.id,
          type: 'specialist-spawned',
          message: `Spawned ${node.specialistRole} for ${node.files.length} file(s): ${node.specialistReason ?? 'file classification'}`,
          payload: {
            nodeId: node.id,
            role: node.specialistRole,
            files: node.files,
            reason: node.specialistReason ?? 'file classification',
            spawnedAgentId: specialistAgent.agentId,
          },
        });
      }

      await this.eventBus.publish(sessionId, {
        taskId: task.id,
        type: 'plan-node-dispatched',
        message: `Dispatching ${node.files.length} file(s) in module ${node.module}${isSpecialist ? ` via ${node.specialistRole}` : ''}`,
        payload: { nodeId: node.id, agentId: node.assignedAgentId, files: node.files, role: node.specialistRole ?? 'general-coder' },
      });

      // Build a single-node plan for execution scope
      const nodeFiles = node.files;
      const nodeModule = node.module;
      const singleNodePlan: EditPlan = {
        instruction: `[node ${node.id}] ${plan.instruction}`,
        nodes: [{ ...node, dependsOn: [] }],
        estimatedComplexity: plan.estimatedComplexity,
        get filesToChange() { return nodeFiles; },
        get modulesAffected() { return [nodeModule]; },
      };

      try {
        let result: GeneralCodingResult;

        if (node.specialistRole === 'synthesizer') {
          // Gap 9: synthesis is a terminal DAG node. Orchestrator owns the
          // contextStore I/O and event emission; SynthesisAgent is a pure
          // merge+verify function with no factory-module dependencies.
          result = await this.dispatchSynthesisNode(task, dag, secCtx, sessionId);
        } else if (isSpecialist && specialistAgent) {
          // Route through SpecialistAgentFactory.execute() — uses the spawned
          // agent with its role-scoped memory and system prompt.
          result = await this.specialistFactory.execute(
            specialistAgent,
            task,
            singleNodePlan,
            repoMapText,
            projectRules,
            skillsPrefix,
            collectionName,
            secCtx,
            trace,
            sessionId,
            node.id,   // Gap 8: pass nodeId so Langfuse span is scoped specialist-execute:{role}:{nodeId}
          );
        } else {
          // Standard path: general-coder via ConversationalLoop
          result = await this.loop.runTurns(
            task, singleNodePlan, repoMapText, projectRules, skillsPrefix,
            collectionName, secCtx, trace, sessionId,
          );
        }

        node.status = 'complete';
        node.result = {
          appliedEdits:       result.appliedEdits,
          commitHash:         result.commitHash,
          verificationPassed: result.verificationPassed,
          tokensUsed:         result.tokensUsed,
        };
        span.end({ output: { status: 'complete', tokensUsed: result.tokensUsed } });

        // Check for newly discovered entanglements — amend DAG if needed
        await this.maybeAmendDag(task, dag, node, plan, sessionId, secCtx, trace);

        await this.persistDag(task.id, dag);
        const unlocked = dag.filter(n => n.status === 'pending' && this.isReady(n, dag));
        await this.eventBus.publish(sessionId, {
          taskId: task.id,
          type: 'plan-node-complete',
          message: `Node ${node.id} complete — ${unlocked.length} node(s) unlocked`,
          payload: { nodeId: node.id, status: 'complete', unlockedNodes: unlocked.map(n => n.id) },
        });

        // Dispatch newly unlocked nodes in parallel
        await Promise.all(unlocked.map(n => dispatchNode(n)));
      } catch (err) {
        node.status = 'failed';
        span.end({ output: { status: 'failed', error: String(err) } });
        await this.persistDag(task.id, dag);
        await this.eventBus.publish(sessionId, {
          taskId: task.id,
          type: 'plan-node-complete',
          message: `Node ${node.id} failed: ${String(err)}`,
          payload: { nodeId: node.id, status: 'failed', unlockedNodes: [] },
        });
      }
    };

    // Subscribe to interventions — checked after each node completes
    const unsubscribe = await this.eventBus.subscribe(task.id, async (event) => {
      if (event.type === 'plan-node-complete') {
        const intervention = await this.interventions.consumeIntervention(task.id);
        if (intervention?.type === 'cancel') {
          // Mark all pending/dispatched nodes as failed and propagate
          dag.filter(n => n.status === 'pending' || n.status === 'dispatched')
             .forEach(n => { n.status = 'failed'; });
          await this.persistDag(task.id, dag);
        }
      }
    });

    try {
      // Dispatch all initially ready nodes in parallel
      const initialReady = dag.filter(n => this.isReady(n, dag));
      await Promise.all(initialReady.map(n => dispatchNode(n)));

      // Apply partial-failure policy
      const failed   = dag.filter(n => n.status === 'failed');
      const failRate = failed.length / dag.length;

      if (failed.length > 0) {
        if (failRate <= FAILURE_BUDGET) {
          // Retry failed nodes once
          const retrySpan = trace.span({ name: 'retry-failed-nodes', input: { nodeIds: failed.map(n => n.id) } });
          failed.forEach(n => { n.status = 'pending'; });
          await Promise.all(failed.map(n => dispatchNode(n)));
          retrySpan.end();
        } else {
          // Above failure budget — emit structured task-failed
          await this.eventBus.publish(sessionId, {
            taskId: task.id,
            type: 'task-failed',
            message: `${failed.length}/${dag.length} nodes failed — exceeds ${FAILURE_BUDGET * 100}% failure budget`,
            payload: { failedNodes: failed.map(n => ({ id: n.id, files: n.files })) },
          });
          return { status: 'failed', appliedEdits: [], verificationPassed: false, tokensUsed: this.totalTokens(dag) };
        }
      }

      // Gap 9: Synthesis ran as the terminal DAG node. Its outcome is stored
      // on the synthesis node's NodeResult; the orchestrator composes the
      // final GeneralCodingResult from it.
      const synthNode = dag.find(n => n.specialistRole === 'synthesizer');
      if (!synthNode || synthNode.status !== 'complete' || !synthNode.result) {
        return {
          status:             'failed',
          appliedEdits:       dag.flatMap(n => n.result?.appliedEdits ?? []),
          verificationPassed: false,
          tokensUsed:         this.totalTokens(dag),
        };
      }
      return {
        status:             synthNode.result.verificationPassed ? 'success' : 'partial',
        appliedEdits:       synthNode.result.appliedEdits,
        commitHash:         synthNode.result.commitHash,
        verificationPassed: synthNode.result.verificationPassed,
        tokensUsed:         this.totalTokens(dag),
      };
    } finally {
      await unsubscribe();
    }
  }

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
  private async maybeAmendDag(
    task: IAgentTask,
    dag: EditPlanNode[],
    completedNode: EditPlanNode,
    originalPlan: EditPlan,
    sessionId: string,
    secCtx: ISecurityContext,
    trace: LangfuseTraceClient,
  ): Promise<void> {
    const allPlannedFiles = new Set(dag.flatMap(n => n.files));
    const newlyEntangled = (completedNode.result?.appliedEdits ?? [])
      .filter(f => !allPlannedFiles.has(f));

    if (newlyEntangled.length === 0) return;

    const dagBefore = dag.map(n => ({ id: n.id, status: n.status }));

    // Gap 2 fix: load per-tenant rules for correct multi-tenant classification
    // TenantRulesLoader caches with 60 s Redis TTL — zero per-call Vault traffic
    const tenantRules = await this.specialistFactory.loadTenantRulesForClassifier(task.tenantId);

    // v9.5.1: Classify each newly discovered file — zero-latency pattern match
    const addedNodes: EditPlanNode[] = newlyEntangled.map((file, i) => {
      const classification = this.fileClassifier.classify(file, tenantRules);  // Gap 2: pass tenantRules
      return {
        id:                `${completedNode.id}-amendment-${i}`,
        files:             [file],
        module:            completedNode.module,
        changeDescription: `Amendment: propagate changes from node ${completedNode.id} to ${file}`,
        dependsOn:         [completedNode.id],
        status:            'pending',
        specialistRole:    classification?.role,
        specialistReason:  classification?.reason,
      };
    });

    dag.push(...addedNodes);

    // Gap 9: keep the terminal synthesis node's dependsOn in sync with the DAG
    // so amendments added mid-flight are also awaited before merge runs.
    const synthNode = dag.find(n => n.specialistRole === 'synthesizer');
    if (synthNode) {
      const deps = new Set(synthNode.dependsOn);
      for (const n of addedNodes) deps.add(n.id);
      synthNode.dependsOn = [...deps];
    }

    await this.persistDag(task.id, dag);  // persist BEFORE emitting event

    await this.eventBus.publish(sessionId, {
      taskId: task.id,
      type: 'plan-amended',
      message: `Plan updated: ${newlyEntangled.length} additional file(s) discovered during editing`,
      payload: {
        reason: `Entanglement detected in node ${completedNode.id}`,
        addedNodes: addedNodes.map(n => ({ id: n.id, files: n.files, role: n.specialistRole ?? 'general-coder' })),
        removedNodes: [],
        dagBefore,
        dagAfter: dag.map(n => ({ id: n.id, status: n.status })),
      },
    });
  }

  /** Returns true if all of node's dependsOn are in status 'complete'. */
  private isReady(node: EditPlanNode, dag: EditPlanNode[]): boolean {
    return node.status === 'pending' &&
           node.dependsOn.every(depId => dag.find(n => n.id === depId)?.status === 'complete');
  }

  /** Persist the live DAG to DistributedContextStore for worker-restart resilience. */
  private async persistDag(taskId: string, dag: EditPlanNode[]): Promise<void> {
    await this.contextStore.save({ id: `gc-dag:${taskId}`, dag });
  }

  /** Sum of tokensUsed across all completed nodes. */
  private totalTokens(dag: EditPlanNode[]): number {
    return dag.reduce((sum, n) => sum + (n.result?.tokensUsed ?? 0), 0);
  }

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
  private stampSpecialistRoles(plan: EditPlan): void {
    for (const node of plan.nodes) {
      if (node.specialistRole) continue;  // already stamped (shouldn't happen on initial plan)

      // A node's specialistRole is determined by its first file that matches a rule.
      // If a node has mixed files (e.g. a migration + a src file), the first match wins.
      // Nodes with mixed concerns should be split by EditPlanner — this is a safety net.
      for (const file of node.files) {
        const classification = this.fileClassifier.classify(file);  // uses built-in rules only
        if (classification) {
          node.specialistRole   = classification.role;
          node.specialistReason = classification.reason;
          break;
        }
      }
    }
  }

  // assertRepoAccess delegated to infrastructure/assertRepoAccess.ts (Phase 1.5)

  /**
   * appendSynthesisNode — Gap 9. Injects a terminal DAG node that runs after
   * every other node completes. Dispatching it flows through dispatchNode()
   * like any other node, keeping the orchestrator's single dispatch path.
   */
  private appendSynthesisNode(plan: EditPlan): void {
    if (plan.nodes.some(n => n.specialistRole === 'synthesizer')) return;  // idempotent
    const allIds = plan.nodes.map(n => n.id);
    plan.nodes.push({
      id:                'synthesis',
      files:             [],
      module:            'synthesis',
      changeDescription: 'Merge parallel DAG node outputs and run final verification',
      dependsOn:         allIds,
      status:            'pending',
      specialistRole:    'synthesizer' as AgentRole,
      specialistReason:  'Terminal DAG synthesis',
    });
  }

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
  private async dispatchSynthesisNode(
    task:      IAgentTask,
    dag:       EditPlanNode[],
    secCtx:    ISecurityContext,
    sessionId: string,
  ): Promise<GeneralCodingResult> {
    const completedNodes = dag.filter(n => n.specialistRole !== 'synthesizer' && n.status === 'complete' && n.result);

    await this.eventBus.publish(sessionId, {
      taskId: task.id,
      type: 'synthesis-started',
      message: `Merging outputs from ${completedNodes.length} node(s)…`,
      payload: { nodeCount: completedNodes.length },
    });

    const fileNodeMap = new Map<string, string[]>();
    for (const node of completedNodes) {
      for (const file of node.result!.appliedEdits) {
        const existing = fileNodeMap.get(file) ?? [];
        fileNodeMap.set(file, [...existing, node.id]);
      }
    }

    const conflictingContentsByFile = new Map<string, string[]>();
    for (const [file, nodeIds] of fileNodeMap) {
      if (nodeIds.length < 2) continue;
      const versions = (await Promise.all(
        nodeIds.map(id => this.contextStore.load(`gc-node-output:${task.id}:${id}:${file}`)),
      ))
        .filter((r): r is import('../agentic/DistributedContextStore.js').ContextRecord => r !== null)
        .map(r => String(r['content'] ?? ''));
      if (versions.length >= 2) conflictingContentsByFile.set(file, versions);
    }

    const outcome = await this.synthesizer.merge(task, completedNodes, conflictingContentsByFile, secCtx);

    for (const [file, merged] of outcome.resolvedConflicts) {
      await this.contextStore.save({ id: `gc-conflict-resolved:${task.id}:${file}`, content: merged });
    }

    return {
      status:             outcome.status,
      appliedEdits:       outcome.appliedEdits,
      commitHash:         outcome.commitHash,
      verificationPassed: outcome.verificationPassed,
      tokensUsed:         outcome.tokensUsed,
    };
  }

  /**
   * deriveSecureCollectionSuffix — v9.1 security fix for namespace injection.
   * HMAC-SHA256(key=tenantId, data=sessionId) binds the namespace to the tenant.
   */
  private deriveSecureCollectionSuffix(tenantId: string, sessionId: string): string {
    const hmac = createHmac('sha256', tenantId);
    hmac.update(sessionId);
    return hmac.digest('hex').slice(0, 16);
  }
}
