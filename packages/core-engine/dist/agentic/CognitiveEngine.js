"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CognitiveEngine = void 0;
const InstrumentedLLMClient_js_1 = require("./InstrumentedLLMClient.js");
const ImmutableAuditLogger_js_1 = require("../governance/ImmutableAuditLogger.js");
const LangfuseTracer_js_1 = require("../observability/LangfuseTracer.js");
class CognitiveEngine {
    baseLlm;
    planner;
    decomposer;
    memory;
    policy;
    anomaly;
    contextStore;
    contextPruner;
    swarm;
    eventBus;
    sessions;
    delivery;
    heartbeat;
    generalCodingOrchestrator;
    constructor(baseLlm, planner, decomposer, memory, policy, anomaly, contextStore, contextPruner, swarm, eventBus, sessions, delivery, heartbeat, generalCodingOrchestrator) {
        this.baseLlm = baseLlm;
        this.planner = planner;
        this.decomposer = decomposer;
        this.memory = memory;
        this.policy = policy;
        this.anomaly = anomaly;
        this.contextStore = contextStore;
        this.contextPruner = contextPruner;
        this.swarm = swarm;
        this.eventBus = eventBus;
        this.sessions = sessions;
        this.delivery = delivery;
        this.heartbeat = heartbeat;
        this.generalCodingOrchestrator = generalCodingOrchestrator;
    }
    async processTask(task) {
        const trace = await (0, LangfuseTracer_js_1.startAgentTrace)(task.id, task.goal.description, task.userId);
        const auditLogger = new ImmutableAuditLogger_js_1.ImmutableAuditLogger(task.id);
        const llm = new InstrumentedLLMClient_js_1.InstrumentedLLMClient(this.baseLlm.baseUrl, this.baseLlm.model, trace, task.id, 'orchestrator');
        const secCtx = { permissions: task.securityContext?.permissions ?? ['kilo:submit', 'workspace:write'] };
        const sessionId = task.sessionId ?? task.id;
        let tokensUsed = 0;
        const decisionLog = [];
        await this.heartbeat.start(task.id, sessionId);
        try {
            // v9: ROUTING BRANCH
            if ((task.taskMode ?? 'factory') === 'general-coding') {
                await this.eventBus.publish(sessionId, {
                    taskId: task.id,
                    type: 'stage-started',
                    message: 'Indexing your codebase and building a repo map…',
                    progress: 5,
                });
                const gcResult = await this.generalCodingOrchestrator.handle(task, secCtx, trace, sessionId);
                (0, LangfuseTracer_js_1.scoreTask)(trace, {
                    testPassRate: gcResult.verificationPassed ? 1 : 0,
                    planFeasibility: 1,
                    tokensEfficiency: Math.max(0, 1 - (gcResult.tokensUsed ?? 0) / 100_000),
                });
                await this.sessions.appendTask(sessionId, task.userId ?? '', {
                    taskId: task.id,
                    goal: task.goal.description,
                    outcome: gcResult.status,
                    keyDecisions: gcResult.appliedEdits.map(e => `edited ${e}`),
                    deliveredAt: new Date().toISOString(),
                });
                return {
                    taskId: task.id,
                    selectedPlan: { id: 'general-coding', strategy: 'general-coding', subGoals: [], feasibilityScore: 1, riskScore: 0, estimatedTokens: gcResult.tokensUsed ?? 0 },
                    subGoals: [],
                    recalledMemories: [],
                };
            }
            // ── FACTORY PATH ────────────────────────────────────────────────────────
            // 1. Recall memories
            await this.eventBus.publish(sessionId, { taskId: task.id, type: 'stage-started', message: 'Analysing your requirements...', progress: 5 });
            const recalled = await this.memory.recall({
                tenantId: task.tenantId,
                query: task.goal.description,
                kinds: ['success-pattern', 'tool-heuristic'],
            });
            const recallEntry = { id: `${task.id}:recall`, timestamp: Date.now(), stage: 'memory', decision: 'recalled memories', rationale: `${recalled.length} entries`, requirementRef: task.goal.description, alternatives: [], rejectedReasons: [] };
            await auditLogger.log(recallEntry);
            decisionLog.push(recallEntry);
            // 2. Generate candidate plans
            await this.eventBus.publish(sessionId, { taskId: task.id, type: 'stage-started', message: 'Planning approach...', progress: 15 });
            const goalWithContext = { ...task.goal, context: recalled.map(m => m.summary).join('\n') };
            const plans = await this.planner.generatePlans(goalWithContext);
            this.anomaly.checkRetries(trace.id, task.id, 0);
            const selectedPlan = this.planner.selectBest(plans);
            const planEntry = { id: `${task.id}:plan`, timestamp: Date.now(), stage: 'planning', decision: selectedPlan.strategy, rationale: `feasibility=${selectedPlan.feasibilityScore} risk=${selectedPlan.riskScore}`, requirementRef: task.goal.description, alternatives: plans.filter(p => p.id !== selectedPlan.id).map(p => p.strategy), rejectedReasons: [] };
            await auditLogger.log(planEntry);
            decisionLog.push(planEntry);
            tokensUsed += selectedPlan.estimatedTokens;
            this.policy.assertTokenBudget(tokensUsed, task.id);
            this.anomaly.checkTokenUsage(trace.id, task.id, tokensUsed, 'complex');
            await this.eventBus.publish(sessionId, { taskId: task.id, type: 'stage-completed', message: `Plan selected: ${selectedPlan.strategy}`, progress: 20 });
            // 3. Decompose sub-goals
            const subGoals = await this.decomposer.decompose({ description: selectedPlan.strategy, context: task.goal.description }, trace);
            // 4. Dispatch to swarm (Phase A.4: startTask() resolves prompts + pins atomically)
            await this.eventBus.publish(sessionId, { taskId: task.id, type: 'stage-started', message: 'Generating your application...', progress: 25 });
            const swarmResult = await this.swarm.startTask(task, selectedPlan, subGoals, secCtx, trace, sessionId);
            tokensUsed += swarmResult.tokensUsed;
            this.policy.assertTokenBudget(tokensUsed, task.id);
            // 5. Prune and persist context
            await this.contextPruner.pruneIfNeeded(task.id, trace);
            const ctx = await this.contextStore.load(task.id);
            if (ctx) {
                await this.contextStore.save({ ...ctx, subGoalResults: swarmResult.subGoalResults, agentMessages: swarmResult.agentMessages, tokensBudgetUsed: tokensUsed });
            }
            // 6. Score, consolidate, deliver
            (0, LangfuseTracer_js_1.scoreTask)(trace, { testPassRate: swarmResult.reviewPassed ? 1 : 0, planFeasibility: selectedPlan.feasibilityScore, tokensEfficiency: Math.max(0, 1 - tokensUsed / 100_000) });
            // consolidation is handled by MemoryOrchestrator at a higher level — skip legacy path
            await this.eventBus.publish(sessionId, { taskId: task.id, type: 'stage-started', message: 'Packaging and delivering your app...', progress: 90 });
            const bundle = swarmResult.subGoalResults['export'];
            if (bundle && task.deliveryConfig) {
                if (swarmResult.docFiles?.length) {
                    bundle['docFiles'] = swarmResult.docFiles;
                }
                await this.delivery.deliver(task.id, sessionId, bundle, task.deliveryConfig);
            }
            await this.sessions.appendTask(sessionId, task.userId ?? '', {
                taskId: task.id,
                goal: task.goal.description,
                outcome: 'success',
                keyDecisions: decisionLog.map(d => d.decision),
                deliveredAt: new Date().toISOString(),
            });
            return { taskId: task.id, selectedPlan, subGoals, recalledMemories: recalled };
        }
        catch (err) {
            await this.eventBus.publish(sessionId, { taskId: task.id, type: 'task-failed', message: `Task failed: ${err.message}`, progress: 0 });
            await this.sessions.appendTask(sessionId, task.userId ?? '', {
                taskId: task.id,
                goal: task.goal.description,
                outcome: 'failed',
                keyDecisions: decisionLog.map(d => d.decision),
                deliveredAt: new Date().toISOString(),
            });
            throw err;
        }
        finally {
            await this.heartbeat.cancel(task.id);
        }
    }
}
exports.CognitiveEngine = CognitiveEngine;
//# sourceMappingURL=CognitiveEngine.js.map