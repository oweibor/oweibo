"use strict";
/**
 * MemoryCircuitBreaker — in-process fail-fast breaker for the semantic
 * memory tier. Distinct from RedisCircuitBreaker (which is heavier and
 * keyed to pipeline stages with an IRecoveryAction selector).
 *
 * Closes gap #7: the legacy LongTermMemoryStore had a CircuitBreaker
 * (Phase 0 hardening); QdrantSemanticStore had only try/catch swallowing,
 * so a Qdrant outage cascaded to every memory call.
 *
 * State machine:
 *
 *   CLOSED ──N consecutive failures──► OPEN
 *   OPEN ──cooldown elapsed──► HALF_OPEN
 *   HALF_OPEN ──success──► CLOSED
 *   HALF_OPEN ──failure──► OPEN
 *
 * Lightweight by design: in-memory, no Redis, no recovery-action selection.
 * Per-process state is appropriate for a data-access breaker because the
 * downstream (Qdrant) is shared and a per-process trip is enough to shed
 * load fast and let the worker observe its own recovery.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryCircuitBreaker = exports.MemoryCircuitOpenError = void 0;
class MemoryCircuitOpenError extends Error {
    constructor(name) {
        super(`Memory circuit '${name}' is OPEN — fast-failing call to protect downstream`);
        this.name = 'MemoryCircuitOpenError';
    }
}
exports.MemoryCircuitOpenError = MemoryCircuitOpenError;
class MemoryCircuitBreaker {
    name;
    threshold;
    cooldownMs;
    now;
    state = 'closed';
    failures = 0;
    openedAt = 0;
    constructor(name, opts = {}) {
        this.name = name;
        this.threshold = opts.failureThreshold ?? 3;
        this.cooldownMs = opts.cooldownMs ?? 30_000;
        this.now = opts.now ?? Date.now;
    }
    getState() {
        if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
            this.state = 'half_open';
        }
        return this.state;
    }
    /** True when a call may proceed; false when the breaker is OPEN. */
    allow() {
        return this.getState() !== 'open';
    }
    /** Wrap a function so failures count toward the breaker; throws fast when OPEN. */
    async exec(fn) {
        if (!this.allow())
            throw new MemoryCircuitOpenError(this.name);
        try {
            const out = await fn();
            this.recordSuccess();
            return out;
        }
        catch (err) {
            this.recordFailure();
            throw err;
        }
    }
    recordSuccess() {
        this.state = 'closed';
        this.failures = 0;
        this.openedAt = 0;
    }
    recordFailure() {
        this.failures += 1;
        if (this.state === 'half_open' || this.failures >= this.threshold) {
            this.state = 'open';
            this.openedAt = this.now();
        }
    }
    /** Force the breaker back to CLOSED; mainly for tests. */
    reset() {
        this.state = 'closed';
        this.failures = 0;
        this.openedAt = 0;
    }
}
exports.MemoryCircuitBreaker = MemoryCircuitBreaker;
//# sourceMappingURL=MemoryCircuitBreaker.js.map