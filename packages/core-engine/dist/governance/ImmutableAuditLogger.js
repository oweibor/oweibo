"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImmutableAuditLogger = void 0;
const crypto_1 = require("crypto");
class ImmutableAuditLogger {
    taskId;
    redis;
    lastHash = '0000000000000000000000000000000000000000000000000000000000000000';
    constructor(taskId, redis) {
        this.taskId = taskId;
        this.redis = redis;
    }
    async log(entry) {
        const auditId = `${this.taskId}:${entry.id}`;
        const previousHash = this.lastHash;
        const contentToHash = JSON.stringify({
            ...entry,
            auditId,
            previousHash,
        });
        const entryHash = (0, crypto_1.createHash)('sha256').update(contentToHash).digest('hex');
        const auditEntry = {
            ...entry,
            auditId,
            previousHash,
            entryHash,
        };
        // Write to Redis stream (skipped when redis is not injected — hash chain maintained in memory)
        if (this.redis) {
            await this.redis.xadd(`audit:${this.taskId}`, '*', 'entry', JSON.stringify(auditEntry));
        }
        // Update chain
        this.lastHash = entryHash;
        return auditEntry;
    }
    async getLog() {
        if (!this.redis)
            return [];
        const entries = await this.redis.xrange(`audit:${this.taskId}`, '-', '+');
        return entries.map(([_id, fields]) => {
            const raw = fields[1] ?? '{}';
            return JSON.parse(raw);
        });
    }
    async verifyChain() {
        const entries = await this.getLog();
        let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';
        for (const entry of entries) {
            if (entry.previousHash !== expectedPrevHash) {
                return { valid: false, brokenAt: entry.auditId };
            }
            const contentToHash = JSON.stringify({
                id: entry.id,
                timestamp: entry.timestamp,
                stage: entry.stage,
                decision: entry.decision,
                rationale: entry.rationale,
                requirementRef: entry.requirementRef,
                alternatives: entry.alternatives,
                rejectedReasons: entry.rejectedReasons,
                agentRole: entry.agentRole,
                auditId: entry.auditId,
                previousHash: entry.previousHash,
            });
            const computedHash = (0, crypto_1.createHash)('sha256').update(contentToHash).digest('hex');
            if (computedHash !== entry.entryHash) {
                return { valid: false, brokenAt: entry.auditId };
            }
            expectedPrevHash = entry.entryHash;
        }
        return { valid: true };
    }
    async getKeyDecisions() {
        const entries = await this.getLog();
        // Key decisions are those made by architect or reviewer agents
        return entries.filter(e => e.agentRole === 'architect' || e.agentRole === 'reviewer' || e.stage === 'architect');
    }
}
exports.ImmutableAuditLogger = ImmutableAuditLogger;
//# sourceMappingURL=ImmutableAuditLogger.js.map