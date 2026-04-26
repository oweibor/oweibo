"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCircuitBreaker = void 0;
const DEFAULT_CONFIG = {
    failureThreshold: 3,
    cooldownMs: 30_000,
    halfOpenMaxAttempts: 1,
    windowMs: 60_000,
};
class RedisCircuitBreaker {
    redis;
    stageId;
    config;
    constructor(redis, stageId, config = {}) {
        this.redis = redis;
        this.stageId = stageId;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    get key() {
        return `cb:${this.stageId}`;
    }
    async getState() {
        const data = await this.getData();
        if (data.state === 'open') {
            const elapsed = Date.now() - data.openedAt;
            if (elapsed >= this.config.cooldownMs) {
                await this.transition('half_open');
                return 'half_open';
            }
        }
        return data.state;
    }
    async canExecute() {
        const state = await this.getState();
        if (state === 'closed')
            return true;
        if (state === 'half_open') {
            const data = await this.getData();
            return data.halfOpenAttempts < this.config.halfOpenMaxAttempts;
        }
        return false;
    }
    async recordSuccess() {
        const data = await this.getData();
        if (data.state === 'half_open') {
            await this.reset();
        }
        else {
            await this.setData({ ...data, failures: 0 });
        }
    }
    async recordFailure(error) {
        const data = await this.getData();
        const newFailures = data.failures + 1;
        const now = Date.now();
        if (data.state === 'half_open') {
            await this.transition('open');
            return {
                strategy: 'human-escalation',
                reason: `Circuit for ${this.stageId} re-opened after half-open failure: ${error.message}`,
            };
        }
        const windowExpired = now - data.lastFailureAt > this.config.windowMs;
        const effectiveFailures = windowExpired ? 1 : newFailures;
        if (effectiveFailures >= this.config.failureThreshold) {
            await this.setData({
                state: 'open',
                failures: effectiveFailures,
                lastFailureAt: now,
                openedAt: now,
                halfOpenAttempts: 0,
            });
            return this.selectRecovery(error, effectiveFailures);
        }
        await this.setData({
            ...data,
            failures: effectiveFailures,
            lastFailureAt: now,
        });
        return { strategy: 'retry', delayMs: 1000 * effectiveFailures, reason: error.message };
    }
    async reset() {
        await this.setData({
            state: 'closed', failures: 0, lastFailureAt: 0,
            openedAt: 0, halfOpenAttempts: 0,
        });
    }
    selectRecovery(error, failures) {
        if (error.errorCode === 'LLM_HALLUCINATION') {
            return {
                strategy: 'context-reset',
                reason: `LLM hallucination detected in ${this.stageId} after ${failures} failures`,
                promptAugmentation: 'Previous attempt produced hallucinated output. Focus strictly on verified facts.',
            };
        }
        if (error.errorCode === 'GATE_FAILED' && failures <= 5) {
            return {
                strategy: 'architect-replan',
                reason: `Gate failure in ${this.stageId} — requesting architecture re-plan`,
            };
        }
        return {
            strategy: 'human-escalation',
            reason: `Circuit OPEN for ${this.stageId}: ${failures} consecutive failures`,
        };
    }
    async transition(newState) {
        const data = await this.getData();
        await this.setData({
            ...data,
            state: newState,
            openedAt: newState === 'open' ? Date.now() : data.openedAt,
            halfOpenAttempts: newState === 'half_open' ? 0 : data.halfOpenAttempts,
        });
    }
    async getData() {
        const raw = await this.redis.get(this.key);
        if (!raw) {
            return { state: 'closed', failures: 0, lastFailureAt: 0, openedAt: 0, halfOpenAttempts: 0 };
        }
        return JSON.parse(raw);
    }
    async setData(data) {
        await this.redis.set(this.key, JSON.stringify(data), 'EX', 86400);
    }
}
exports.RedisCircuitBreaker = RedisCircuitBreaker;
//# sourceMappingURL=RedisCircuitBreaker.js.map