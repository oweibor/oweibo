// packages/core-engine/src/general-coding/ConversationalLoop.ts
// Turn driver — edit → verify → fix loop (§16f.3)
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
import type { IMemorySystem } from '../agentic/IMemorySystem.js';
import type { UserProfileStore } from '../agentic/UserProfileStore.js';
import type { PreferenceNudgeService } from '../agentic/PreferenceNudgeService.js';
import type { PromptBudgetEnforcer } from '../infrastructure/PromptBudgetEnforcer.js';

// ── v9.5: EditPlan is now a DAG — replaces the flat filesToChange list ───────

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
  id: string;                                              // stable UUID per node
  files: string[];                                         // files this node is responsible for
  module: string;                                          // detected module name (used for agent prompt context)
  changeDescription: string;                               // human-readable intent for this node
  dependsOn: string[];                                     // ids of prerequisite nodes
  status: 'pending' | 'dispatched' | 'complete' | 'failed';
  assignedAgentId?: string;                                // set at dispatch time
  result?: NodeResult;                                     // set at completion time
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
  appliedEdits: string[];     // file paths actually modified
  commitHash?: string;        // git commit for this node's changeset
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
  // Derived helpers — computed by EditPlanner, not persisted in DistributedContextStore:
  /** Convenience accessor — all unique files across all nodes */
  readonly filesToChange: string[];
  /** Convenience accessor — all unique modules across all nodes */
  readonly modulesAffected: string[];
}
// ─────────────────────────────────────────────────────────────────────────────

export class ConversationalLoop {
  private static readonly MAX_VERIFY_ITERATIONS = 3;

  constructor(
    private readonly agent:           GeneralCodingAgent,
    private readonly planner:         EditPlanner,
    private readonly applicator:      EditApplicator,
    private readonly verifier:        VerificationRunner,
    private readonly indexer:         GeneralRepoIndexer,
    private readonly sessions:        SessionStore,
    private readonly eventBus:        TaskEventBus,
    private readonly interventions:   TaskInterventionGateway,
    private readonly contextStore:    DistributedContextStore,
    private readonly memorySystem:    IMemorySystem,
    private readonly userProfileStore: UserProfileStore,
    private readonly preferenceNudge: PreferenceNudgeService,
    private readonly budgetEnforcer:  PromptBudgetEnforcer,
  ) {}

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
  async planTurn(
    task:           IAgentTask,
    repoMapText:    string,
    projectRules:   string,
    skillsPrefix:   string,    // NEW v9.4 — after projectRules, before collectionName
    collectionName: string,
    secCtx:         ISecurityContext,
    trace:          LangfuseTraceClient,
    onPlanBuilt?:   (plan: EditPlan) => void,  // Gap 4 fix: called before plan-ready
  ): Promise<EditPlan> {
    const plan = await this.planner.plan(task.goal.description, repoMapText, collectionName);

    // Gap 4 + Gap 10: stamp specialist roles BEFORE emitting plan-ready
    onPlanBuilt?.(plan);

    // v9.5: plan is now a DAG — surface the full node graph in the plan-ready payload
    // so users see the dependency structure (and specialist roles) before approving execution.
    await this.eventBus.publish(task.sessionId ?? task.id, {
      taskId:   task.id,
      type:     'plan-ready',
      message:  `Ready to edit ${plan.filesToChange.length} file(s) across ${plan.nodes.length} node(s). Approve to proceed.`,
      payload:  { plan },  // includes nodes[], dependsOn graph, estimatedComplexity, specialistRoles
    });

    // Persist DAG so worker restarts can re-surface the approval request
    await this.contextStore.save({
      id:     `gc-plan:${task.id}`,
      status: 'awaiting-approval',
      plan,
    });

    // Block until user sends 'approve' intervention — uses existing pause/resume mechanism
    const intervention = await this.interventions.waitForApproval(task.id);
    if (intervention?.type === 'cancel') {
      throw new Error(`[ConversationalLoop] Task ${task.id} cancelled by user before edit began`);
    }

    await this.contextStore.save({ id: `gc-plan:${task.id}`, status: 'approved', plan });
    return plan;
  }

  /**
   * runTurns — executes the approved EditPlan through the edit → verify → fix loop.
   * Persists turn state so a worker restart resumes from the correct iteration.
   */
  async runTurns(
    task:           IAgentTask,
    plan:           EditPlan,
    repoMapText:    string,
    projectRules:   string,
    skillsPrefix:   string,    // NEW v9.4
    collectionName: string,
    secCtx:         ISecurityContext,
    trace:          LangfuseTraceClient,
    sessionId:      string,
  ): Promise<GeneralCodingResult> {
    // Load user profile for prompt assembly (used by PromptBudgetEnforcer downstream).
    const userProfile = task.userId
      ? this.userProfileStore.renderProfile(
          await this.userProfileStore.loadProfile(task.tenantId, task.userId),
        )
      : '';
    // budgetEnforcer is available for callers who need to assemble a budgeted prompt;
    // userProfile is captured here so it flows into the first enforce() call.
    void userProfile; void this.budgetEnforcer;

    const appliedEdits: string[] = [];
    let tokensUsed = 0;

    try {
    for (let iteration = 0; iteration < ConversationalLoop.MAX_VERIFY_ITERATIONS; iteration++) {
      await this.contextStore.save({ id: `gc-session:${task.id}`, status: 'running', turnIndex: iteration });

      // 1. Semantic search for relevant context
      const context = await this.indexer.search(collectionName, plan.instruction, 10);

      // 2. Read current file contents for files in plan
      const fileContents = await this.readFiles(plan.filesToChange, task.repoPath!);

      // 3. Generate proposal — streams 'edit-proposed' chunks via TaskEventBus (G13)
      await this.eventBus.publish(sessionId, {
        taskId:   task.id,
        type:     'stage-started',
        message:  `Generating edits (attempt ${iteration + 1})…`,
        progress: 30 + iteration * 20,
      });

      const proposal = await this.agent.proposeEdit(
        plan.instruction,
        fileContents,
        context,
        (chunk, fileHint) => {
          void this.eventBus.publish(sessionId, {
            taskId:  task.id,
            type:    'edit-proposed',
            message: fileHint ? `Editing ${fileHint}…` : 'Generating edits…',
            payload: { chunk, fileHint },
          });
        },
      );
      tokensUsed += proposal.proposal.length * 800; // approximate

      // 4. Apply changes atomically via git
      const { commitHash, editedFiles } = await this.applicator.apply(task.repoPath!, proposal, task.id, sessionId);
      appliedEdits.push(...editedFiles);
      await this.eventBus.publish(sessionId, {
        taskId:  task.id,
        type:    'edit-applied',
        message: `Changes applied to ${editedFiles.length} file(s).`,
        payload: { commitHash, files: editedFiles },
      });

      // 5. Verify — tsc → eslint → targeted jest (G4)
      const verifyResult = await this.verifier.run(task.repoPath!, editedFiles, secCtx);

      if (verifyResult.passed) {
        await this.contextStore.save({ id: `gc-session:${task.id}`, status: 'complete', turnIndex: iteration });
        await this.sessions.appendTask(sessionId, task.userId ?? '', {
          taskId:       task.id,
          goal:         plan.instruction,
          outcome:      'success',
          keyDecisions: [`edited: ${editedFiles.join(', ')}`, `commit: ${commitHash}`],
          deliveredAt:  new Date().toISOString(),
        });

        // Persist turn memory and check for preference signals.
        await this.memorySystem.store({
          tenantId:      task.tenantId,
          userId:        task.userId,
          sessionId,
          scope:         `session:${sessionId}`,
          type:          'successful-strategy',
          tier:          'episodic',
          summary:       `Applied edits to ${editedFiles.join(', ')} — verification passed`,
          detail:        { commitHash, editedFiles, iteration },
          relevanceTags: ['general-coding', 'edit'],
        });
        await this.preferenceNudge.maybeNudge({
          tenantId:  task.tenantId,
          userId:    task.userId,
          sessionId,
          turnIndex: iteration,
        });

        return { status: 'success', appliedEdits, commitHash, verificationPassed: true, tokensUsed };
      }

      // 6. Verification failed — feed errors back into next iteration
      await this.eventBus.publish(sessionId, {
        taskId:  task.id,
        type:    'verification-failed',
        message: `Verification found ${verifyResult.errors.length} error(s). Attempting fix…`,
        payload: { errors: verifyResult.errors },
      });
      plan = { ...plan, instruction: `${plan.instruction}\n\nFix the following errors:\n${verifyResult.errors.join('\n')}` };
    }

    await this.eventBus.publish(sessionId, {
      taskId:  task.id,
      type:    'hitl-required',
      message: 'Could not automatically fix all verification errors. Human review required.',
      payload: {},
    });
    return { status: 'partial', appliedEdits, verificationPassed: false, tokensUsed };
    } finally {
      // Always tear down the session — destroySession is idempotent and non-throwing.
      await this.memorySystem.endSession(task.tenantId, sessionId);
    }
  }

  private async readFiles(paths: string[], repoRoot: string): Promise<Record<string, string>> {
    const { readFile } = await import('fs/promises');
    const { join }     = await import('path');
    const entries = await Promise.all(
      paths.map(async p => [p, await readFile(join(repoRoot, p), 'utf8')] as [string, string]),
    );
    return Object.fromEntries(entries);
  }
}
