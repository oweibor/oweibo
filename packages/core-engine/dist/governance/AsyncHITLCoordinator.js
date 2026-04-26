"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncHITLCoordinator = void 0;
const SAFE_PATTERNS = new Set([
    'read-only-analysis',
    'test-execution',
    'lint-check',
    'type-check',
    'documentation-generation',
    'repo-indexing',
    'dependency-audit',
]);
class AsyncHITLCoordinator {
    hitl;
    redis;
    pendingEscalations = new Map(); // taskId:stageId → requestId
    constructor(hitl, redis) {
        this.hitl = hitl;
        this.redis = redis;
    }
    isSafePattern(pattern) {
        return SAFE_PATTERNS.has(pattern);
    }
    async escalateIfNeeded(escalation) {
        // Safe patterns never need HITL
        if (this.isSafePattern(escalation.stageId)) {
            return { requiresWait: false };
        }
        // Check if already escalated for this task+stage
        const key = `${escalation.taskId}:${escalation.stageId}`;
        const existing = this.pendingEscalations.get(key);
        if (existing) {
            return { requiresWait: true, requestId: existing };
        }
        const requestId = await this.hitl.escalate({
            taskId: escalation.taskId,
            agentId: escalation.agentId,
            message: {
                id: `hitl-${Date.now()}`,
                from: escalation.agentId,
                to: 'human',
                type: 'escalate',
                payload: escalation.payload,
                traceId: escalation.taskId,
                timestamp: Date.now(),
            },
            reason: escalation.reason,
            escalatedAt: Date.now(),
        });
        this.pendingEscalations.set(key, requestId);
        // Non-blocking escalations let the pipeline continue
        if (!escalation.blocking) {
            return { requiresWait: false, requestId };
        }
        return { requiresWait: true, requestId };
    }
    async waitForApproval(requestId, timeoutMs = 300_000) {
        return this.hitl.waitForDecision(requestId, timeoutMs);
    }
    async getDecisionIfReady(requestId) {
        // Non-blocking check — returns null if still pending
        const raw = await this.redis.hget(`hitl:${requestId}`, 'data');
        if (!raw)
            return null;
        const request = JSON.parse(raw);
        return request.status !== 'pending' ? request : null;
    }
    clearEscalation(taskId, stageId) {
        this.pendingEscalations.delete(`${taskId}:${stageId}`);
    }
}
exports.AsyncHITLCoordinator = AsyncHITLCoordinator;
//# sourceMappingURL=AsyncHITLCoordinator.js.map