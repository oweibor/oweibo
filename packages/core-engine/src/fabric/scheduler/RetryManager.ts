/**
 * K.0 (ADR-013 §3.5): RetryManager — pure retry/backoff/dead-letter policy.
 *
 * Deliberately side-effect free: JobQueue applies the decisions; this class
 * only computes them, so the policy is unit-testable and the operational
 * defaults (ADR-013 §6) live in exactly one place.
 *
 * - Exponential backoff with FULL jitter: delay = U(0,1) * min(cap, base*2^n)
 * - Retry budgets per job class; exhaustion → dead-letter (§3.5)
 */
import type { JobClass } from './contract';

/** ADR-013 §6 operational defaults — tunable without reopening the ADR. */
export const DEFAULT_RETRY_BUDGETS: Readonly<Record<JobClass, number>> = {
  1: 10, // ACL / membership / delete — most persistent
  2: 10, // incremental content
  3: 5,  // user-triggered reindex
  4: 5,  // initial crawl / backfill
  5: 1,  // activity signals — recomputable, barely worth retrying
};

export const DEFAULT_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_BACKOFF_CAP_MS = 15 * 60_000; // 15 min

export interface RetryManagerOptions {
  readonly budgets?: Readonly<Record<JobClass, number>>;
  readonly baseMs?: number;
  readonly capMs?: number;
  /** Override randomness; tests pin it. Must return [0, 1). */
  readonly random?: () => number;
}

export class RetryManager {
  private readonly budgets: Readonly<Record<JobClass, number>>;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly random: () => number;

  constructor(opts: RetryManagerOptions = {}) {
    this.budgets = opts.budgets ?? DEFAULT_RETRY_BUDGETS;
    this.baseMs = opts.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.capMs = opts.capMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.random = opts.random ?? Math.random;
  }

  /** True when the job has exhausted its class budget and must dead-letter. */
  shouldDeadLetter(jobClass: JobClass, attempts: number): boolean {
    return attempts >= this.budgets[jobClass];
  }

  /**
   * Full-jitter exponential backoff for the NEXT attempt after `attempts`
   * failures. attempts=1 → U(0,1)*min(cap, base*2), etc.
   */
  backoffMs(attempts: number): number {
    const exp = Math.min(this.capMs, this.baseMs * Math.pow(2, Math.max(1, attempts)));
    return Math.floor(this.random() * exp);
  }
}
