"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HITLGateway = void 0;
const crypto_1 = require("crypto");
class HITLGateway {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async escalate(request) {
        const requestId = (0, crypto_1.randomUUID)();
        const stored = {
            ...request,
            requestId,
            status: 'pending',
        };
        // Store in Redis hash
        await this.redis.hset(`hitl:${requestId}`, 'data', JSON.stringify(stored));
        await this.redis.expire(`hitl:${requestId}`, 86400 * 7);
        // Add to pending set for the task
        await this.redis.sadd(`hitl:pending:${request.taskId}`, requestId);
        // Publish event for SSE subscribers
        await this.redis.publish(`task:${request.taskId}:events`, JSON.stringify({
            type: 'hitl-required',
            taskId: request.taskId,
            payload: { requestId, reason: request.reason, agentId: request.agentId },
            timestamp: Date.now(),
        }));
        return requestId;
    }
    async approve(requestId, decision) {
        const stored = await this.getRequest(requestId);
        if (!stored)
            throw new Error(`HITL request ${requestId} not found`);
        if (stored.status !== 'pending')
            throw new Error(`HITL request ${requestId} already ${stored.status}`);
        stored.status = 'approved';
        stored.decidedAt = Date.now();
        stored.decidedBy = decision.userId;
        stored.decisionReason = decision.reason;
        stored.modifications = decision.modifications;
        await this.redis.hset(`hitl:${requestId}`, 'data', JSON.stringify(stored));
        await this.redis.srem(`hitl:pending:${stored.taskId}`, requestId);
        // Publish approval event
        await this.redis.publish(`task:${stored.taskId}:events`, JSON.stringify({
            type: 'intervention-applied',
            taskId: stored.taskId,
            payload: { requestId, decision: 'approved', modifications: decision.modifications },
            timestamp: Date.now(),
        }));
    }
    async reject(requestId, decision) {
        const stored = await this.getRequest(requestId);
        if (!stored)
            throw new Error(`HITL request ${requestId} not found`);
        if (stored.status !== 'pending')
            throw new Error(`HITL request ${requestId} already ${stored.status}`);
        stored.status = 'rejected';
        stored.decidedAt = Date.now();
        stored.decidedBy = decision.userId;
        stored.decisionReason = decision.reason;
        await this.redis.hset(`hitl:${requestId}`, 'data', JSON.stringify(stored));
        await this.redis.srem(`hitl:pending:${stored.taskId}`, requestId);
    }
    async listPending(tenantId) {
        const pattern = 'hitl:pending:*';
        const keys = await this.redis.keys(pattern);
        const pending = [];
        for (const key of keys) {
            const requestIds = await this.redis.smembers(key);
            for (const requestId of requestIds) {
                const request = await this.getRequest(requestId);
                if (request && request.status === 'pending') {
                    pending.push(request);
                }
            }
        }
        return pending;
    }
    async waitForDecision(requestId, timeoutMs = 300_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const request = await this.getRequest(requestId);
            if (request && request.status !== 'pending')
                return request;
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error(`HITL request ${requestId} timed out after ${timeoutMs}ms`);
    }
    async getRequest(requestId) {
        const raw = await this.redis.hget(`hitl:${requestId}`, 'data');
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
}
exports.HITLGateway = HITLGateway;
//# sourceMappingURL=HITLGateway.js.map