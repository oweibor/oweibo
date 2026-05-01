// packages/core-engine/src/agentic/SwarmCoordinator.ts
// Multi-agent swarm dispatcher (§16d.3)
import { randomUUID } from 'crypto';
import type {
  IAgent, AgentMessage, ISubGoal, Plan, ISecurityContext,
} from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import {
  GenericAgent,
  ARCHITECT_SYSTEM_PROMPT,
  EXECUTOR_SYSTEM_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  DOMAIN_SPECIALIST_SYSTEM_PROMPT,
} from './BaseAgent.js';
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
  ) {
    this.conflictResolver = conflictResolver;
  }

  async coordinate(
    taskId:    string,
    tenantId:  string,
    plan:      Plan,
    subGoals:  ISubGoal[],
    secCtx:    ISecurityContext,
    trace:     LangfuseTraceClient,
    sessionId?: string,
  ): Promise<SwarmResult> {
    const pubId = sessionId ?? taskId;
    const makeLlm = (): ILLMClient =>
      new InstrumentedLLMClient(this.baseLlm.baseUrl, this.baseLlm.model, trace);

    const architect  = new GenericAgent('architect',         makeLlm(), this.memory, ARCHITECT_SYSTEM_PROMPT,         trace, taskId, tenantId);
    const executor   = new GenericAgent('executor',          makeLlm(), this.memory, EXECUTOR_SYSTEM_PROMPT,          trace, taskId, tenantId);
    const reviewer   = new GenericAgent('reviewer',          makeLlm(), this.memory, REVIEWER_SYSTEM_PROMPT,          trace, taskId, tenantId);
    const specialist = new GenericAgent('domain-specialist', makeLlm(), this.memory, DOMAIN_SPECIALIST_SYSTEM_PROMPT, trace, taskId, tenantId);

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
        group.map(sg => this.executeSubGoal(sg, taskId, pubId, architect, executor, reviewer, specialist, secCtx, trace, allMessages)),
      );

      for (const gr of groupResults) {
        subGoalResults[gr.subGoalDescription] = gr.result;
        tokensUsed += gr.tokensUsed;
        allMessages.push(...gr.messages);

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
    specialist:   IAgent,
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
