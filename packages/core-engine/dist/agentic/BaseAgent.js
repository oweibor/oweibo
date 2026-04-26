"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericAgent = exports.DOMAIN_SPECIALIST_SYSTEM_PROMPT = exports.REVIEWER_SYSTEM_PROMPT = exports.EXECUTOR_SYSTEM_PROMPT = exports.ARCHITECT_SYSTEM_PROMPT = exports.BaseAgent = void 0;
const crypto_1 = require("crypto");
class BaseAgent {
    llm;
    memory;
    systemPrompt;
    trace;
    taskId;
    tenantId;
    agentId;
    role;
    memoryScope;
    constructor(role, llm, memory, systemPrompt, trace, taskId, tenantId) {
        this.llm = llm;
        this.memory = memory;
        this.systemPrompt = systemPrompt;
        this.trace = trace;
        this.taskId = taskId;
        this.tenantId = tenantId;
        this.role = role;
        this.agentId = `${role}:${taskId}`;
        this.memoryScope = `${role}:${taskId}`;
    }
    async recall(query, topK = 5) {
        const entries = await this.memory.recall(this.tenantId, query, { topK });
        if (entries.length === 0)
            return '';
        return entries.map(e => `[Memory] ${e.entry.summary}`).join('\n');
    }
    async remember(content, metadata) {
        await this.memory.store({
            tenantId: this.tenantId,
            scope: this.memoryScope,
            type: 'tool-heuristic',
            tier: 'episodic',
            summary: content,
            detail: metadata ?? {},
            relevanceTags: [],
        });
    }
    respond(original, payload) {
        return {
            id: (0, crypto_1.randomUUID)(),
            from: this.agentId,
            to: original.from,
            type: 'result',
            payload,
            traceId: original.traceId,
            timestamp: Date.now(),
        };
    }
    challengeMsg(original, reason) {
        return {
            id: (0, crypto_1.randomUUID)(),
            from: this.agentId,
            to: original.from,
            type: 'challenge',
            payload: { reason, originalPayload: original.payload },
            traceId: original.traceId,
            timestamp: Date.now(),
        };
    }
}
exports.BaseAgent = BaseAgent;
// ─── System prompts (referenced by SwarmCoordinator) ─────────────────────────
exports.ARCHITECT_SYSTEM_PROMPT = 'You are the Architect agent. Decompose goals into a precise, ordered plan.';
exports.EXECUTOR_SYSTEM_PROMPT = 'You are the Executor agent. Carry out plan steps faithfully and report results.';
exports.REVIEWER_SYSTEM_PROMPT = 'You are the Reviewer agent. Audit executor outputs and challenge defects.';
exports.DOMAIN_SPECIALIST_SYSTEM_PROMPT = 'You are a Domain Specialist. Provide expertise specific to the requested domain.';
/** Concrete generic agent — used by SwarmCoordinator for the four standard roles. */
class GenericAgent extends BaseAgent {
    async process(message) {
        const out = await this.llm.generate({
            systemPrompt: this.systemPrompt,
            userPrompt: typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload),
        });
        return this.respond(message, out.output ?? '');
    }
}
exports.GenericAgent = GenericAgent;
//# sourceMappingURL=BaseAgent.js.map