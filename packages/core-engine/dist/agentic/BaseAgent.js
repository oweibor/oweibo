"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericAgent = exports.BaseAgent = void 0;
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
        const entries = await this.memory.recall({ tenantId: this.tenantId, query, topK });
        if (entries.length === 0)
            return '';
        return entries.map(e => `[Memory] ${e.summary}`).join('\n');
    }
    async remember(content, metadata) {
        await this.memory.store({
            scope: {
                tenantId: this.tenantId,
                taskId: this.taskId,
            },
            kind: 'tool-heuristic',
            summary: content,
            detail: metadata,
            importance: 0.5,
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
// DONE: Phase A.4 — static prompt constants removed; prompts now come from CohortRouter.
// Stable-v0 fallback strings live in CohortRouter.STABLE_V0_FALLBACKS.
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