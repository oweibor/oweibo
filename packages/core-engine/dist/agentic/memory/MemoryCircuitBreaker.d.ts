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
export type BreakerState = 'closed' | 'open' | 'half_open';
export interface MemoryCircuitBreakerOptions {
    /** Consecutive failures that trip the breaker. Default 3. */
    readonly failureThreshold?: number;
    /** Cooldown before half-open is allowed. Default 30s. */
    readonly cooldownMs?: number;
    /** Clock injection for tests. Default Date.now. */
    readonly now?: () => number;
}
export declare class MemoryCircuitOpenError extends Error {
    constructor(name: string);
}
export declare class MemoryCircuitBreaker {
    private readonly name;
    private readonly threshold;
    private readonly cooldownMs;
    private readonly now;
    private state;
    private failures;
    private openedAt;
    constructor(name: string, opts?: MemoryCircuitBreakerOptions);
    getState(): BreakerState;
    /** True when a call may proceed; false when the breaker is OPEN. */
    allow(): boolean;
    /** Wrap a function so failures count toward the breaker; throws fast when OPEN. */
    exec<T>(fn: () => Promise<T>): Promise<T>;
    recordSuccess(): void;
    recordFailure(): void;
    /** Force the breaker back to CLOSED; mainly for tests. */
    reset(): void;
}
//# sourceMappingURL=MemoryCircuitBreaker.d.ts.map