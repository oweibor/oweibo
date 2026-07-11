/**
 * K.1 convention (ADR-012 §3.5) — retry/backoff for authored code that
 * composes multiple source APIs behind one port.
 *
 * The policy SHAPE mirrors the scheduler's (ADR-013 RetryManager:
 * exponential base with full jitter, hard delay cap) without importing it
 * — the SDK depends on nothing platform-side (INV-17 keeps the arrow
 * pointing one way). Values here are convention defaults (Expected to
 * evolve), not the scheduler's per-class budgets.
 *
 * Retry classification is taxonomy-driven: ONLY `transient` PortErrors
 * are retried. `permanent` needs intervention, `partial` is a health
 * signal for the runtime, `corrupt_poison` must quarantine — retrying
 * any of those hides the condition the taxonomy exists to surface.
 * Non-PortError exceptions are NOT retried here (unknown ≠ safe); the
 * platform pipeline applies its own budgeted safe-default handling.
 */
import { PortError } from '../ports/types.js';

export interface RetryOptions {
  /** Maximum attempts including the first. Default 4. */
  readonly maxAttempts?: number;
  /** Exponential base delay in ms. Default 250. */
  readonly baseDelayMs?: number;
  /** Hard cap per delay in ms. Default 10_000. */
  readonly maxDelayMs?: number;
  /** Injected for deterministic tests. */
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Full-jitter delay for a 1-based attempt number. Exported for tests. */
export function retryDelayMs(
  attempt: number,
  opts: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const base = opts.baseDelayMs ?? 250;
  const cap = opts.maxDelayMs ?? 10_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/**
 * Run `fn`, retrying transient PortErrors with full-jitter backoff.
 * Rethrows the last error when attempts are exhausted; rethrows
 * immediately on anything that is not a transient PortError.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof PortError && err.failureClass === 'transient';
      if (!retryable || attempt >= maxAttempts) throw err;
      await sleep(retryDelayMs(attempt, opts));
    }
  }
}
