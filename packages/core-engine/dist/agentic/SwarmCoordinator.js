"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmCoordinator = void 0;
// packages/core-engine/src/agentic/SwarmCoordinator.ts
// Multi-agent swarm dispatcher (§16d.3)
const crypto_1 = require("crypto");
const BaseAgent_js_1 = require("./BaseAgent.js");
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
    conflictResolver;
    constructor(baseLlm, memory, policy, anomaly, auditLogger, conflictResolver, eventBus, interventionGateway, decomposer, contextStore, sessions) {
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
        this.conflictResolver = conflictResolver;
    }
    async coordinate(taskId, tenantId, plan, subGoals, secCtx, trace, sessionId) {
        const pubId = sessionId ?? taskId;
        const makeLlm = () => new InstrumentedLLMClient_js_1.InstrumentedLLMClient(this.baseLlm.baseUrl, this.baseLlm.model, trace);
        const architect = new BaseAgent_js_1.GenericAgent('architect', makeLlm(), this.memory, BaseAgent_js_1.ARCHITECT_SYSTEM_PROMPT, trace, taskId, tenantId);
        const executor = new BaseAgent_js_1.GenericAgent('executor', makeLlm(), this.memory, BaseAgent_js_1.EXECUTOR_SYSTEM_PROMPT, trace, taskId, tenantId);
        const reviewer = new BaseAgent_js_1.GenericAgent('reviewer', makeLlm(), this.memory, BaseAgent_js_1.REVIEWER_SYSTEM_PROMPT, trace, taskId, tenantId);
        const specialist = new BaseAgent_js_1.GenericAgent('domain-specialist', makeLlm(), this.memory, BaseAgent_js_1.DOMAIN_SPECIALIST_SYSTEM_PROMPT, trace, taskId, tenantId);
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
            const groupResults = await Promise.all(group.map(sg => this.executeSubGoal(sg, taskId, pubId, architect, executor, reviewer, specialist, secCtx, trace, allMessages)));
            for (const gr of groupResults) {
                subGoalResults[gr.subGoalDescription] = gr.result;
                tokensUsed += gr.tokensUsed;
                allMessages.push(...gr.messages);
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
    async executeSubGoal(sg, taskId, pubId, architect, executor, reviewer, specialist, secCtx, trace, allMessages) {
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