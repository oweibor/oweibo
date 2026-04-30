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
  readonly cooldownMs?:       number;
  /** Clock injection for tests. Default Date.now. */
  readonly now?: () => number;
}

export class MemoryCircuitOpenError extends Error {
  constructor(name: string) {
    super(`Memory circuit '${name}' is OPEN — fast-failing call to protect downstream`);
    this.name = 'MemoryCircuitOpenError';
  }
}

export class MemoryCircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now:        () => number;

  private state:    BreakerState = 'closed';
  private failures: number       = 0;
  private openedAt: number       = 0;

  constructor(
    private readonly name: string,
    opts: MemoryCircuitBreakerOptions = {},
  ) {
    this.threshold  = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs       ?? 30_000;
    this.now        = opts.now              ?? Date.now;
  }

  getState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  /** True when a call may proceed; false when the breaker is OPEN. */
  allow(): boolean {
    return this.getState() !== 'open';
  }

  /** Wrap a function so failures count toward the breaker; throws fast when OPEN. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allow()) throw new MemoryCircuitOpenError(this.name);
    try {
      const out = await fn();
      this.recordSuccess();
      return out;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    this.state    = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state    = 'open';
      this.openedAt = this.now();
    }
  }

  /** Force the breaker back to CLOSED; mainly for tests. */
  reset(): void {
    this.state    = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }
}
