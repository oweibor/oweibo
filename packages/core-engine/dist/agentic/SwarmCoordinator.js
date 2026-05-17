"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmCoordinator = void 0;
// packages/core-engine/src/agentic/SwarmCoordinator.ts
// DONE: Phase A.4 — CohortRouter integration + startTask() with atomic DB pin
// Multi-agent swarm dispatcher (§16d.3)
const crypto_1 = require("crypto");
const BaseAgent_js_1 = require("./BaseAgent.js");
const CohortRouter_js_1 = require("../infrastructure/CohortRouter.js");
const core_contracts_1 = require("@oweibo/core-contracts");
const LangfuseTracer_js_1 = require("../observability/LangfuseTracer.js");
const InstrumentedLLMClient_js_1 = require("./InstrumentedLLMClient.js");
/**
 * SwarmCoordinator — dispatches sub-goals to specialist agents in parallel,
 * collects outputs, routes through ReviewerAgent, and resolves conflicts.
 *
 * v5: Checks TaskInterventionGateway at each sub-goal group boundary.
 * v7: Stamps lastSubGoalCompletedAt in DistributedContextStore after each group.
 * v9.1: DocFiles moved to DocGenerationStage (after SmokeTest).
 */
class SwarmCoordinator {
    baseLlm;
    memory;
    policy;
    anomaly;
    auditLogger;
    eventBus;
    interventionGateway;
    decomposer;
    contextStore;
    sessions;
    pgPool;
    cohortRouter;
    safetyChecker;
    conflictResolver;
    constructor(baseLlm, memory, policy, anomaly, auditLogger, conflictResolver, eventBus, interventionGateway, decomposer, contextStore, sessions, pgPool, cohortRouter, 
    /** D.7: optional production safety checker — fires on 5% sample of executor output. */
    safetyChecker) {
        this.baseLlm = baseLlm;
        this.memory = memory;
        this.policy = policy;
        this.anomaly = anomaly;
        this.auditLogger = auditLogger;
        this.eventBus = eventBus;
        this.interventionGateway = interventionGateway;
        this.decomposer = decomposer;
        this.contextStore = contextStore;
        this.sessions = sessions;
        this.pgPool = pgPool;
        this.cohortRouter = cohortRouter;
        this.safetyChecker = safetyChecker;
        this.conflictResolver = conflictResolver;
    }
    /**
     * Entry point for CognitiveEngine (Phase A.4+).
     * Resolves prompts via CohortRouter, writes all assembled hashes atomically
     * with the task INSERT into oweibo.tasks, then runs the swarm.
     *
     * Invariant §2.3: hash columns and task INSERT are in the same Postgres transaction.
     */
    async startTask(task, plan, subGoals, secCtx, trace, sessionId) {
        const channel = 'stable-v0'; // Phase D.1 will derive from tenant cohort settings
        // Resolve all four role prompts
        const resolved = this.cohortRouter
            ? await this.cohortRouter.resolveAllRoles(task.id, channel)
            : null;
        const prompts = {
            architect: resolved?.architect?.promptText ?? CohortRouter_js_1.STABLE_V0_FALLBACKS['architect'],
            executor: resolved?.executor?.promptText ?? CohortRouter_js_1.STABLE_V0_FALLBACKS['executor'],
            reviewer: resolved?.reviewer?.promptText ?? CohortRouter_js_1.STABLE_V0_FALLBACKS['reviewer'],
            decomposer: resolved?.decomposer?.promptText ?? CohortRouter_js_1.STABLE_V0_FALLBACKS['decomposer'],
        };
        // Atomically write task row + assembled hashes (invariant §2.3)
        if (this.pgPool) {
            const client = await this.pgPool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO oweibo.tasks
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
             started_at                = NOW()`, [
                    task.id, task.tenantId, task.userId ?? null,
                    sessionId ?? null, task.taskMode,
                    task.goal.description, task.goal.context ?? null,
                    task.repoPath ?? null, channel,
                    resolved?.architect?.assembledHash ?? 'stable-v0',
                    resolved?.executor?.assembledHash ?? 'stable-v0',
                    resolved?.reviewer?.assembledHash ?? 'stable-v0',
                    resolved?.decomposer?.assembledHash ?? 'stable-v0',
                    resolved ? JSON.stringify({
                        architect: resolved.architect?.slotPins,
                        executor: resolved.executor?.slotPins,
                        reviewer: resolved.reviewer?.slotPins,
                        decomposer: resolved.decomposer?.slotPins,
                    }) : null,
                ]);
                await client.query('COMMIT');
            }
            catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
            finally {
                client.release();
            }
        }
        const resolvedMeta = resolved ? {
            channel: channel,
            hashes: {
                architect: resolved.architect?.assembledHash ?? 'stable-v0',
                executor: resolved.executor?.assembledHash ?? 'stable-v0',
                reviewer: resolved.reviewer?.assembledHash ?? 'stable-v0',
                decomposer: resolved.decomposer?.assembledHash ?? 'stable-v0',
            },
        } : undefined;
        return this.coordinate(task.id, task.tenantId, plan, subGoals, secCtx, trace, sessionId, prompts, resolvedMeta);
    }
    async coordinate(taskId, tenantId, plan, subGoals, secCtx, trace, sessionId, agentPrompts, resolvedMeta) {
        const pubId = sessionId ?? taskId;
        const makeLlm = (role) => new InstrumentedLLMClient_js_1.InstrumentedLLMClient(this.baseLlm.baseUrl, this.baseLlm.model, trace, taskId, role);
        const p = agentPrompts ?? CohortRouter_js_1.STABLE_V0_FALLBACKS;
        const [rArchitect, rExecutor, rReviewer, rDecomposer] = core_contracts_1.CANONICAL_ROLES;
        const architect = new BaseAgent_js_1.GenericAgent(rArchitect, makeLlm(rArchitect), this.memory, p.architect, trace, taskId, tenantId);
        const executor = new BaseAgent_js_1.GenericAgent(rExecutor, makeLlm(rExecutor), this.memory, p.executor, trace, taskId, tenantId);
        const reviewer = new BaseAgent_js_1.GenericAgent(rReviewer, makeLlm(rReviewer), this.memory, p.reviewer, trace, taskId, tenantId);
        const decomposer = new BaseAgent_js_1.GenericAgent(rDecomposer, makeLlm(rDecomposer), this.memory, p.decomposer, trace, taskId, tenantId);
        const allMessages = [];
        const subGoalResults = {};
        let tokensUsed = 0;
        let reviewPassed = true;
        let ordered = this.topologicalSort(subGoals);
        for (const group of ordered) {
            // v5: Check for user intervention at safe checkpoint
            const intervention = await this.interventionGateway.consume(taskId);
            if (intervention) {
                if (intervention.type === 'cancel') {
                    await this.eventBus.publish(pubId, { taskId, type: 'task-failed', message: `Task cancelled: ${intervention.instruction}`, progress: 0 });
                    throw new Error(`[SwarmCoordinator] Task ${taskId} cancelled by user: ${intervention.instruction}`);
                }
                if (intervention.type === 'pause') {
                    await this.eventBus.publish(pubId, { taskId, type: 'stage-started', message: 'Task paused. Waiting for resume...', progress: undefined });
                    while (true) {
                        await new Promise(r => setTimeout(r, 5000));
                        const resume = await this.interventionGateway.consume(taskId);
                        if (resume?.type === 'redirect') {
                            Object.assign(intervention, { type: 'redirect', instruction: resume.instruction });
                            break;
                        }
                        if (!resume || resume.type !== 'pause')
                            break;
                    }
                }
                if (intervention.type === 'redirect' || intervention.type === 'add-constraint') {
                    const remainingDescs = ordered.flat().map(sg => sg.description);
                    const refined = await this.decomposer.decompose({
                        description: plan.strategy,
                        context: `User instruction: ${intervention.instruction}. Remaining: ${remainingDescs.join(', ')}`,
                    });
                    ordered = this.topologicalSort(refined);
                    await this.eventBus.publish(pubId, { taskId, type: 'intervention-applied', message: `Adjusting: "${intervention.instruction}"`, progress: undefined });
                    continue;
                }
            }
            const groupResults = await Promise.all(group.map(sg => this.executeSubGoal(sg, taskId, pubId, architect, executor, reviewer, decomposer, secCtx, trace, allMessages)));
            for (const gr of groupResults) {
                subGoalResults[gr.subGoalDescription] = gr.result;
                tokensUsed += gr.tokensUsed;
                allMessages.push(...gr.messages);
                // D.7: async safety check on executor output — fire-and-forget, never blocks
                if (this.safetyChecker && resolvedMeta) {
                    const outputText = typeof gr.result === 'string' ? gr.result : JSON.stringify(gr.result);
                    this.safetyChecker.sampleAndCheck(outputText, {
                        channel: resolvedMeta.channel,
                        promptHash: resolvedMeta.hashes.executor,
                        role: core_contracts_1.CANONICAL_ROLES[1],
                        taskId,
                    });
                }
                if (!gr.reviewPassed) {
                    reviewPassed = false;
                    await this.auditLogger.log({
                        id: (0, crypto_1.randomUUID)(),
                        timestamp: Date.now(),
                        stage: 'swarm:review',
                        decision: `ReviewerAgent BLOCKING challenge on: ${gr.subGoalDescription}`,
                        rationale: JSON.stringify(gr.reviewChallenge),
                        requirementRef: plan.strategy,
                        alternatives: [],
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
            knowledgeArtifact: subGoalResults['export']?.['knowledgeArtifact'],
            clarificationHistory: session?.cumulativeContext ?? '',
            adrs: allMessages.filter(m => m.type === 'challenge' || m.type === 'consensus'),
            testSummaries: [],
        } : null;
        return { subGoalResults, agentMessages: allMessages, tokensUsed, reviewPassed, docFiles: [], docContext };
    }
    async executeSubGoal(sg, taskId, pubId, architect, executor, reviewer, decomposer, secCtx, trace, allMessages) {
        const messages = [];
        const tokensUsed = 0;
        this.policy.assertWorkspacePath(sg.input?.['workspacePath'] ?? '/workspaces/default', taskId);
        if (sg.toolName)
            this.anomaly.checkToolInvocation(trace.id, taskId, sg.toolName);
        const architectMsg = { id: (0, crypto_1.randomUUID)(), from: 'orchestrator', to: architect.agentId, type: 'assign', payload: { subGoal: sg.description, input: sg.input }, traceId: trace.id, timestamp: Date.now() };
        const architectResponse = await (0, LangfuseTracer_js_1.tracedToolCall)(trace, 'architect-agent', architectMsg, () => architect.process(architectMsg));
        messages.push(architectMsg, architectResponse);
        const executorMsg = { id: (0, crypto_1.randomUUID)(), from: architect.agentId, to: executor.agentId, type: 'assign', payload: architectResponse.payload, traceId: trace.id, timestamp: Date.now() };
        const executorResponse = await (0, LangfuseTracer_js_1.tracedToolCall)(trace, 'executor-agent', executorMsg, () => executor.process(executorMsg));
        messages.push(executorMsg, executorResponse);
        const reviewMsg = { id: (0, crypto_1.randomUUID)(), from: executor.agentId, to: reviewer.agentId, type: 'result', payload: executorResponse.payload, traceId: trace.id, timestamp: Date.now() };
        const reviewResponse = await (0, LangfuseTracer_js_1.tracedToolCall)(trace, 'reviewer-agent', reviewMsg, () => reviewer.process(reviewMsg));
        messages.push(reviewMsg, reviewResponse);
        if (reviewResponse.type === 'challenge') {
            await this.eventBus.publish(pubId, { taskId, type: 'agent-challenge', message: `Reviewing ${sg.description.slice(0, 60)}...` });
            const resolution = await this.conflictResolver.resolve(taskId, executorResponse, reviewResponse, secCtx, trace);
            messages.push(...resolution.messages);
            await this.eventBus.publish(pubId, {
                taskId,
                type: resolution.accepted ? 'conflict-resolved' : 'agent-challenge',
                message: resolution.accepted ? 'Review passed after revision.' : 'Review escalated to operator.',
            });
            return { subGoalDescription: sg.description, result: resolution.acceptedOutput, tokensUsed, messages, reviewPassed: resolution.accepted, reviewChallenge: reviewResponse.payload };
        }
        return { subGoalDescription: sg.description, result: executorResponse.payload, tokensUsed, messages, reviewPassed: true };
    }
    topologicalSort(subGoals) {
        const resolved = new Set();
        const groups = [];
        let remaining = [...subGoals];
        while (remaining.length > 0) {
            const group = remaining.filter(sg => (sg.dependsOn ?? []).every(dep => resolved.has(dep)));
            if (group.length === 0) {
                groups.push(remaining);
                break;
            }
            groups.push(group);
            group.forEach(sg => resolved.add(sg.description));
            remaining = remaining.filter(sg => !resolved.has(sg.description));
        }
        return groups;
    }
}
exports.SwarmCoordinator = SwarmCoordinator;
//# sourceMappingURL=SwarmCoordinator.js.map