"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EntropyTracker = void 0;
const RULE_OF_3_THRESHOLD = 3;
const MAX_ENTROPY_BEFORE_ESCALATION = 5;
class EntropyTracker {
    redis;
    taskId;
    entries = new Map();
    constructor(redis, taskId) {
        this.redis = redis;
        this.taskId = taskId;
    }
    async recordFailure(stageId, errorMessage) {
        const signature = this.computeErrorSignature(errorMessage);
        const key = `${this.taskId}:${stageId}`;
        const existing = this.entries.get(key) ?? [];
        existing.push({
            stageId,
            attempt: existing.length + 1,
            errorSignature: signature,
            timestamp: Date.now(),
        });
        this.entries.set(key, existing);
        // Persist to Redis for cross-worker visibility
        await this.redis.lpush(`entropy:${key}`, JSON.stringify({ signature, timestamp: Date.now() }));
        await this.redis.expire(`entropy:${key}`, 3600);
        return this.detectViolation(stageId, existing);
    }
    async recordSuccess(stageId) {
        const key = `${this.taskId}:${stageId}`;
        this.entries.delete(key);
        await this.redis.del(`entropy:${key}`);
    }
    async getFailureCount(stageId) {
        const key = `${this.taskId}:${stageId}`;
        return this.entries.get(key)?.length ?? 0;
    }
    async reset() {
        for (const key of this.entries.keys()) {
            await this.redis.del(`entropy:${key}`);
        }
        this.entries.clear();
    }
    buildResetContext(violation) {
        return [
            `ARCHITECT RESET — the previous approach has failed ${violation.attempts} times.`,
            `Stage: ${violation.stageId}`,
            `Error pattern: ${violation.errorPattern}`,
            '',
            'The current architecture is not viable. You MUST:',
            '1. Acknowledge the specific failure pattern above',
            '2. Identify the root cause (not just the symptom)',
            '3. Choose a fundamentally different approach',
            '4. Explain why the new approach avoids the identified failure mode',
        ].join('\n');
    }
    detectViolation(stageId, entries) {
        if (entries.length < RULE_OF_3_THRESHOLD)
            return null;
        // Check last N entries for similar error signatures
        const recent = entries.slice(-RULE_OF_3_THRESHOLD);
        const signatures = recent.map(e => e.errorSignature);
        const firstSig = signatures[0];
        if (firstSig === undefined)
            return null;
        const allSimilar = signatures.every(s => this.isSimilar(s, firstSig));
        if (!allSimilar)
            return null;
        const attempts = entries.length;
        let recommendation;
        if (attempts >= MAX_ENTROPY_BEFORE_ESCALATION) {
            recommendation = 'human-escalation';
        }
        else if (attempts >= RULE_OF_3_THRESHOLD + 1) {
            recommendation = 'strategy-pivot';
        }
        else {
            recommendation = 'architect-reset';
        }
        return {
            stageId,
            attempts,
            errorPattern: firstSig,
            recommendation,
        };
    }
    computeErrorSignature(error) {
        // Normalize: strip line numbers, file paths, UUIDs, timestamps
        return error
            .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '<TIMESTAMP>')
            .replace(/:\d+:\d+/g, ':<LINE>')
            .replace(/\/[^\s]+\//g, '<PATH>/')
            .trim()
            .slice(0, 200);
    }
    isSimilar(a, b) {
        if (a === b)
            return true;
        // Simple Jaccard similarity on word tokens
        const wordsA = new Set(a.toLowerCase().split(/\s+/));
        const wordsB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
        const union = new Set([...wordsA, ...wordsB]);
        return union.size > 0 && intersection.size / union.size > 0.7;
    }
}
exports.EntropyTracker = EntropyTracker;
//# sourceMappingURL=EntropyTracker.js.map