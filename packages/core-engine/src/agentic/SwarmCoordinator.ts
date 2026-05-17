// packages/core-engine/src/agentic/SwarmCoordinator.ts
// DONE: Phase A.4 — CohortRouter integration + startTask() with atomic DB pin
// Multi-agent swarm dispatcher (§16d.3)
import { randomUUID } from 'crypto';
import type {
  IAgent, AgentMessage, ISubGoal, Plan, ISecurityContext, IAgentTask,
} from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import type { Pool } from 'pg';
import { GenericAgent } from './BaseAgent.js';
import {
  CohortRouter, STABLE_V0_FALLBACKS,
} from '../infrastructure/CohortRouter.js';
import { CANONICAL_ROLES } from '@oweibo/core-contracts';
import type { CanonicalRole } from '@oweibo/core-contracts';
import { ConflictResolver } from './ConflictResolver.js';
import { tracedToolCall } from '../observability/LangfuseTracer.js';
import { InstrumentedLLMClient } from './InstrumentedLLMClient.js';
import type { ILLMClient } from '@oweibo/core-contracts';
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
  agentMessages:  AgentMessage[];
  tokensUsed:     number;
  reviewPassed:   boolean;
  docFiles:       ArtifactFile[];
  docContext:     unknown | null;
}

/**
 * SwarmCoordinator — dispatches sub-goals to specialist agents in parallel,
 * collects outputs, routes through ReviewerAgent, and resolves conflicts.
 *
 * v5: Checks TaskInterventionGateway at each sub-goal group boundary.
 * v7: Stamps lastSubGoalCompletedAt in DistributedContextStore after each group.
 * v9.1: DocFiles moved to DocGenerationStage (after SmokeTest).
 */
export class SwarmCoordinator {
  private readonly conflictResolver: ConflictResolver;

  constructor(
    private readonly baseLlm:             { baseUrl: string; model: string },
    private readonly memory:              ISemanticMemoryStore,
    private readonly policy:              PolicyEngine,
    private readonly anomaly:             AnomalyDetector,
    private readonly auditLogger:         ImmutableAuditLogger,
    conflictResolver:                     ConflictResolver,
    private readonly eventBus:            TaskEventBus,
    private readonly interventionGateway: TaskInterventionGateway,
    private readonly decomposer:          GoalDecomposer,
    private readonly contextStore:        DistributedContextStore,
    private readonly sessions:            SessionStore,
    private readonly pgPool?:             Pool,
    private readonly cohortRouter?:       CohortRouter,
    /** D.7: optional production safety checker — fires on 5% sample of executor output. */
    private readonly safetyChecker?:     ProductionSafetyChecker,
    /** D.1: optional cohort admin — resolves per-tenant cohort_channel from tenant_settings. */
    private readonly cohortAdmin?:       CohortAdminService,
  ) {
    this.conflictResolver = conflictResolver;
  }

  /**
   * Entry point for CognitiveEngine (Phase A.4+).
   * Resolves prompts via CohortRouter, writes all assembled hashes atomically
   * with the task INSERT into oweibo.tasks, then runs the swarm.
   *
   * Invariant §2.3: hash columns and task INSERT are in the same Postgres transaction.
   */
  async startTask(
    task:      IAgentTask,
    plan:      Plan,
    subGoals:  ISubGoal[],
    secCtx:    ISecurityContext,
    trace:     LangfuseTraceClient,
    sessionId?: string,
  ): Promise<SwarmResult> {
    // D.1: derive channel from tenant_settings.cohort_channel; fall back to
    // 'stable-v0' if no CohortAdminService is wired or the lookup fails.
    const channel = this.cohortAdmin
      ? await this.cohortAdmin.resolveCohortFor(task.tenantId)
      : 'stable-v0';

    // Resolve all four role prompts
    const resolved = this.cohortRouter
      ? await this.cohortRouter.resolveAllRoles(task.id, channel)
      : null;

    const prompts: Record<CanonicalRole, string> = {
      architect:  resolved?.architect?.promptText  ?? (STABLE_V0_FALLBACKS['architect'] as string),
      executor:   resolved?.executor?.promptText   ?? (STABLE_V0_FALLBACKS['executor']  as string),
      reviewer:   resolved?.reviewer?.promptText   ?? (STABLE_V0_FALLBACKS['reviewer']  as string),
      decomposer: resolved?.decomposer?.promptText ?? (STABLE_V0_FALLBACKS['decomposer'] as string),
    };

    // Atomically write task row + assembled hashes (invariant §2.3)
    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO oweibo.tasks
             (id, tenant_id, user_id, session_id, task_mode, goal_description, goal_context,
              repo_path, status, cohort_channel,
              architect_assembled_hash, executor_assembled_hash,
              reviewer_assembled_hash, decomposer_assembled_hash,
              slot_pin_detail, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,$11,$12,$13,$14,NOW())
           ON CONFLICT (id) DO UPDATE SET
             status = 'running',
             cohort_channel            = EXCLUDED.cohort_channel,
             architect_assembled_hash  = EXCLUDED.architect_assembled_hash,
             executor_assembled_hash   = EXCLUDED.executor_assembled_hash,
             reviewer_assembled_hash   = EXCLUDED.reviewer_assembled_hash,
             decomposer_assembled_hash = EXCLUDED.decomposer_assembled_hash,
             slot_pin_detail           = EXCLUDED.slot_pin_detail,
             started_at                = NOW()`,
          [
            task.id, task.tenantId, task.userId ?? null,
            sessionId ?? null, task.taskMode,
            task.goal.description, task.goal.context ?? null,
            task.repoPath ?? null, channel,
            resolved?.architect?.assembledHash  ?? 'stable-v0',
            resolved?.executor?.assembledHash   ?? 'stable-v0',
            resolved?.reviewer?.assembledHash   ?? 'stable-v0',
            resolved?.decomposer?.assembledHash ?? 'stable-v0',
            resolved ? JSON.stringify({
              architect:  resolved.architect?.slotPins,
              executor:   resolved.executor?.slotPins,
              reviewer:   resolved.reviewer?.slotPins,
              decomposer: resolved.decomposer?.slotPins,
            }) : null,
          ],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    const resolvedMeta = resolved ? {
      channel: channel,
      hashes:  {
        architect:  resolved.architect?.assembledHash  ?? 'stable-v0',
        executor:   resolved.executor?.assembledHash   ?? 'stable-v0',
        reviewer:   resolved.reviewer?.assembledHash   ?? 'stable-v0',
        decomposer: resolved.decomposer?.assembledHash ?? 'stable-v0',
      } as Record<CanonicalRole, string>,
    } : undefined;

    return this.coordinate(task.id, task.tenantId, plan, subGoals, secCtx, trace, sessionId, prompts, resolvedMeta);
  }

  async coordinate(
    taskId:    string,
    tenantId:  string,
    plan:      Plan,
    subGoals:  ISubGoal[],
    secCtx:    ISecurityContext,
    trace:     LangfuseTraceClient,
    sessionId?:      string,
    agentPrompts?:   Record<CanonicalRole, string>,
    resolvedMeta?:   { channel: string; hashes: Record<CanonicalRole, string> },
  ): Promise<SwarmResult> {
    const pubId = sessionId ?? taskId;
    const makeLlm = (role: string): ILLMClient =>
      new InstrumentedLLMClient(this.baseLlm.baseUrl, this.baseLlm.model, trace, taskId, role);

    const p = agentPrompts ?? STABLE_V0_FALLBACKS;
    const [rArchitect, rExecutor, rReviewer, rDecomposer] = CANONICAL_ROLES as readonly [CanonicalRole, CanonicalRole, CanonicalRole, CanonicalRole];
    const architect  = new GenericAgent(rArchitect,  makeLlm(rArchitect),  this.memory, p.architect,  trace, taskId, tenantId);
    const executor   = new GenericAgent(rExecutor,   makeLlm(rExecutor),   this.memory, p.executor,   trace, taskId, tenantId);
    const reviewer   = new GenericAgent(rReviewer,   makeLlm(rReviewer),   this.memory, p.reviewer,   trace, taskId, tenantId);
    const decomposer = new GenericAgent(rDecomposer, makeLlm(rDecomposer), this.memory, p.decomposer, trace, taskId, tenantId);

    const allMessages:    AgentMessage[] = [];
    const subGoalResults: Record<string, unknown> = {};
    let tokensUsed  = 0;
    let reviewPassed = true;

    let ordered = this.topologicalSort(subGoals);

    for (const group of ordered) {
      // v5: Check for user intervention at safe checkpoint
      const intervention = await (this.interventionGateway as any).consume(taskId);
      if (intervention) {
        if (intervention.type === 'cancel') {
          await this.eventBus.publish(pubId, { taskId, type: 'task-failed', message: `Task cancelled: ${intervention.instruction}`, progress: 0 });
          throw new Error(`[SwarmCoordinator] Task ${taskId} cancelled by user: ${intervention.instruction}`);
        }
        if (intervention.type === 'pause') {
          await this.eventBus.publish(pubId, { taskId, type: 'stage-started', message: 'Task paused. Waiting for resume...', progress: undefined });
          while (true) {
            await new Promise(r => setTimeout(r, 5000));
            const resume = await (this.interventionGateway as any).consume(taskId);
            if (resume?.type === 'redirect') { Object.assign(intervention, { type: 'redirect', instruction: resume.instruction }); break; }
            if (!resume || resume.type !== 'pause') break;
          }
        }
        if (intervention.type === 'redirect' || intervention.type === 'add-constraint') {
          const remainingDescs = ordered.flat().map(sg => sg.description);
          const refined = await this.decomposer.decompose({
            description: plan.strategy,
            context:     `User instruction: ${intervention.instruction}. Remaining: ${remainingDescs.join(', ')}`,
          });
          ordered = this.topologicalSort(refined);
          await this.eventBus.publish(pubId, { taskId, type: 'intervention-applied', message: `Adjusting: "${intervention.instruction}"`, progress: undefined });
          continue;
        }
      }

      const groupResults = await Promise.all(
        group.map(sg => this.executeSubGoal(sg, taskId, pubId, architect, executor, reviewer, decomposer, secCtx, trace, allMessages)),
      );

      for (const gr of groupResults) {
        subGoalResults[gr.subGoalDescription] = gr.result;
        tokensUsed += gr.tokensUsed;
        allMessages.push(...gr.messages);

        // D.7: async safety check on executor output — fire-and-forget, never blocks
        if (this.safetyChecker && resolvedMeta) {
          const outputText = typeof gr.result === 'string' ? gr.result : JSON.stringify(gr.result);
          this.safetyChecker.sampleAndCheck(outputText, {
            channel:    resolvedMeta.channel,
            promptHash: resolvedMeta.hashes.executor,
            role:       CANONICAL_ROLES[1],
            taskId,
          });
        }

        if (!gr.reviewPassed) {
          reviewPassed = false;
          await this.auditLogger.log({
            id:             randomUUID(),
            timestamp:      Date.now(),
            stage:          'swarm:review',
            decision:       `ReviewerAgent BLOCKING challenge on: ${gr.subGoalDescription}`,
            rationale:      JSON.stringify(gr.reviewChallenge),
            requirementRef: plan.strategy,
            alternatives:   [],
            rejectedReasons: [JSON.stringify(gr.reviewChallenge)],
          });
        }
      }

      // v7: stamp progress timestamp
      const ctxAfterGroup = await this.contextStore.load(taskId);
      if (ctxAfterGroup) {
        await this.contextStore.save({ ...ctxAfterGroup, lastSubGoalCompletedAt: Date.now(), stalledBeatCount: 0 });
      }
    }

    // v9.1: docFiles now populated by DocGenerationStage
    const session = await this.sessions.load(sessionId ?? taskId);
    const docContext = reviewPassed ? {
      knowledgeArtifact:   (subGoalResults['export'] as Record<string, unknown>)?.['knowledgeArtifact'],
      clarificationHistory: (session as any)?.cumulativeContext ?? '',
      adrs:                allMessages.filter(m => m.type === 'challenge' || m.type === 'consensus'),
      testSummaries:       [],
    } : null;

    return { subGoalResults, agentMessages: allMessages, tokensUsed, reviewPassed, docFiles: [], docContext };
  }

  private async executeSubGoal(
    sg:           ISubGoal,
    taskId:       string,
    pubId:        string,
    architect:    IAgent,
    executor:     IAgent,
    reviewer:     IAgent,
    decomposer:   IAgent,
    secCtx:       ISecurityContext,
    trace:        LangfuseTraceClient,
    allMessages:  AgentMessage[],
  ): Promise<{ subGoalDescription: string; result: unknown; tokensUsed: number; messages: AgentMessage[]; reviewPassed: boolean; reviewChallenge?: unknown }> {
    const messages:  AgentMessage[] = [];
    const tokensUsed = 0;

    this.policy.assertWorkspacePath(sg.input?.['workspacePath'] as string ?? '/workspaces/default', taskId);
    if (sg.toolName) this.anomaly.checkToolInvocation(trace.id, taskId, sg.toolName);

    const architectMsg: AgentMessage = { id: randomUUID(), from: 'orchestrator', to: architect.agentId, type: 'assign', payload: { subGoal: sg.description, input: sg.input }, traceId: trace.id, timestamp: Date.now() };
    const architectResponse = await tracedToolCall(trace, 'architect-agent', architectMsg, () => architect.process(architectMsg));
    messages.push(architectMsg, architectResponse);

    const executorMsg: AgentMessage = { id: randomUUID(), from: architect.agentId, to: executor.agentId, type: 'assign', payload: architectResponse.payload, traceId: trace.id, timestamp: Date.now() };
    const executorResponse = await tracedToolCall(trace, 'executor-agent', executorMsg, () => executor.process(executorMsg));
    messages.push(executorMsg, executorResponse);

    const reviewMsg: AgentMessage = { id: randomUUID(), from: executor.agentId, to: reviewer.agentId, type: 'result', payload: executorResponse.payload, traceId: trace.id, timestamp: Date.now() };
    const reviewResponse = await tracedToolCall(trace, 'reviewer-agent', reviewMsg, () => reviewer.process(reviewMsg));
    messages.push(reviewMsg, reviewResponse);

    if (reviewResponse.type === 'challenge') {
      await this.eventBus.publish(pubId, { taskId, type: 'agent-challenge', message: `Reviewing ${sg.description.slice(0, 60)}...` });
      const resolution = await this.conflictResolver.resolve(taskId, executorResponse, reviewResponse, secCtx, trace);
      messages.push(...resolution.messages);
      await this.eventBus.publish(pubId, {
        taskId,
        type:    resolution.accepted ? 'conflict-resolved' : 'agent-challenge',
        message: resolution.accepted ? 'Review passed after revision.' : 'Review escalated to operator.',
      });
      return { subGoalDescription: sg.description, result: resolution.acceptedOutput, tokensUsed, messages, reviewPassed: resolution.accepted, reviewChallenge: reviewResponse.payload };
    }

    return { subGoalDescription: sg.description, result: executorResponse.payload, tokensUsed, messages, reviewPassed: true };
  }

  private topologicalSort(subGoals: ISubGoal[]): ISubGoal[][] {
    const resolved = new Set<string>();
    const groups:   ISubGoal[][] = [];
    let remaining   = [...subGoals];

    while (remaining.length > 0) {
      const group = remaining.filter(sg => (sg.dependsOn ?? []).every(dep => resolved.has(dep)));
      if (group.length === 0) { groups.push(remaining); break; }
      groups.push(group);
      group.forEach(sg => resolved.add(sg.description));
      remaining = remaining.filter(sg => !resolved.has(sg.description));
    }
    return groups;
  }
}
