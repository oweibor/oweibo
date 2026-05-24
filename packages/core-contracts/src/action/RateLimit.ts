/**
 * S.2 (ttv-action-safety-v2): per-tenant action rate-limit contracts.
 *
 * Distinct from S.6 quotas (absolute caps over long windows):
 *   - S.2 = short-window flow control (per-minute / per-hour / per-day buckets)
 *   - S.6 = monthly / yearly absolute spend caps with budget insurance
 *
 * Policy is stored per (tenant × actionClass). Lookup order at the gate:
 *   1. tenant + exact actionClass
 *   2. tenant + '*'  (tenant default)
 *   3. PLATFORM_DEFAULT_MATRIX (computed)
 *
 * The cold-start window deliberately tightens budgets for new tenants;
 * the multiplier ramps linearly back to 1.0 over the final 50% of the
 * cold-start duration so tenants don't hit a sudden 10× jump on day N.
 */
import type { ActionClass } from './ActionClass.js';

export type RateLimitEnforcementMode = 'soft' | 'hard';

export type RateLimitWindowKind = 'minute' | 'hour' | 'day';

export interface RateLimitPolicy {
  readonly tenantId: string;
  readonly actionClass: ActionClass | '*';
  readonly perMinute: number;
  readonly perHour: number;
  readonly perDay: number;
  /** Tokens above per-minute steady-state allowed to burst. */
  readonly burstAllowance: number;
  /** 0.05..1.0 — multiplier applied to all buckets during cold-start. */
  readonly coldStartMultiplier: number;
  /** Days after tenant creation during which the multiplier applies. */
  readonly coldStartDurationDays: number;
  /** Soft = `rate_limited` (retryable); hard = `forbidden`. Default 'soft'. */
  readonly enforcementMode: RateLimitEnforcementMode;
}

/**
 * The four-window snapshot of a tenant's current bucket usage, used by
 * the admin "current consumption" dashboard and by metrics.
 */
export interface RateLimitConsumption {
  readonly minute: { readonly used: number; readonly capacity: number };
  readonly hour:   { readonly used: number; readonly capacity: number };
  readonly day:    { readonly used: number; readonly capacity: number };
}

/**
 * Pluggable token-bucket backend. The hot path uses a Redis-backed
 * implementation in production; tests use an in-memory implementation
 * with deterministic time.
 */
export interface ITokenBucketStore {
  /**
   * Attempt to consume `tokens` from each named bucket. Returns the worst
   * remaining-time-to-refill across all buckets:
   *   - allowed = true  → all buckets had capacity; tokens consumed
   *   - allowed = false → at least one bucket was empty; nothing consumed;
   *                       `retryAfterMs` indicates when the most-constrained
   *                       bucket will refill enough to allow this request
   */
  tryConsume(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    /** [windowKind, capacity] tuples. Capacity already has cold-start applied. */
    readonly buckets: ReadonlyArray<{ readonly window: RateLimitWindowKind; readonly capacity: number }>;
    readonly tokens?: number;   // default 1
  }): Promise<{
    readonly allowed: boolean;
    readonly retryAfterMs: number;
    /** The bucket that ran out (or 'all' when allowed). */
    readonly limitingWindow: RateLimitWindowKind | 'all';
  }>;

  /** Read current consumption for the admin dashboard. */
  consumption(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly capacities: { readonly minute: number; readonly hour: number; readonly day: number };
  }): Promise<RateLimitConsumption>;
}
