"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConflictResolver = void 0;
// packages/core-engine/src/agentic/ConflictResolver.ts
// Arbitration between executor and reviewer disagreements (§16d.4)
const crypto_1 = require("crypto");
/**
 * ConflictResolver — mediates between executor and reviewer when a challenge is raised.
 * If resolution cannot be reached, escalates to HITLGateway.
 */
class ConflictResolver {
    hitl;
    constructor(hitl) {
        this.hitl = hitl;
    }
    async resolve(taskId, executorMsg, reviewerMsg, secCtx, trace) {
        const messages = [];
        // Attempt 1: Accept reviewer's challenge — return the reviewer-corrected output if present
        const correctedOutput = reviewerMsg.payload?.['correctedOutput'];
        if (correctedOutput !== undefined) {
            const resolution = {
                id: (0, crypto_1.randomUUID)(),
                from: 'conflict-resolver',
                to: 'orchestrator',
                type: 'consensus',
                payload: { resolution: 'reviewer-correction-accepted', output: correctedOutput },
                traceId: trace.id,
                timestamp: Date.now(),
            };
            messages.push(resolution);
            return { accepted: true, acceptedOutput: correctedOutput, messages };
        }
        // Attempt 2: Accept executor's output (reviewer's challenge is non-blocking)
        const challenge = reviewerMsg.payload?.['severity'];
        if (challenge !== 'blocking') {
            const resolution = {
                id: (0, crypto_1.randomUUID)(),
                from: 'conflict-resolver',
                to: 'orchestrator',
                type: 'consensus',
                payload: { resolution: 'executor-output-accepted-non-blocking-challenge', output: executorMsg.payload },
                traceId: trace.id,
                timestamp: Date.now(),
            };
            messages.push(resolution);
            return { accepted: true, acceptedOutput: executorMsg.payload, messages };
        }
        // Blocking conflict — escalate to HITL
        await this.hitl.escalate({
            taskId,
            agentId: executorMsg.from,
            message: reviewerMsg,
            reason: 'blocking-review-challenge',
            escalatedAt: Date.now(),
        });
        const escalationMsg = {
            id: (0, crypto_1.randomUUID)(),
            from: 'conflict-resolver',
            to: 'orchestrator',
            type: 'challenge',
            payload: { resolution: 'escalated-to-hitl', challenge: reviewerMsg.payload },
            traceId: trace.id,
            timestamp: Date.now(),
        };
        messages.push(escalationMsg);
        return { accepted: false, acceptedOutput: null, messages };
    }
}
exports.ConflictResolver = ConflictResolver;
//# sourceMappingURL=ConflictResolver.js.map