/**
 * S.2: TokenBucketStore — in-memory implementation of ITokenBucketStore.
 *
 * Production deployments inject a Redis-backed implementation that runs the
 * bucket math via a Lua script for atomicity across replicas; that adapter
 * is wired in the runtime package once Redis is part of the action-safety
 * dependency closure. This in-memory implementation:
 *   - Is the default for tests (no external state).
 *   - Is the dev / local default when no Redis URL is configured.
 *   - Is per-process; running multiple replicas with this store DOES NOT
 *     enforce a global rate limit. Production MUST use the Redis adapter.
 *
 * Token math is the classic refill formula:
 *   tokens(t) = min(capacity, tokens(t0) + capacity * (t - t0) / windowMs)
 * Each window (minute/hour/day) has its own bucket keyed by
 * `${tenantId}:${actionClass}:${window}`.
 */
import type {
  ITokenBucketStore,
  RateLimitWindowKind,
  RateLimitConsumption,
} from '@oweibo/core-contracts';

interface BucketState {
  capacity: number;
  tokens: number;
  lastRefillMs: number;
}

const WINDOW_MS: Readonly<Record<RateLimitWindowKind, number>> = {
  minute: 60 * 1000,
  hour:   60 * 60 * 1000,
  day:    24 * 60 * 60 * 1000,
};

export class InMemoryTokenBucketStore implements ITokenBucketStore {
  private readonly buckets = new Map<string, BucketState>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async tryConsume(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly buckets: ReadonlyArray<{ readonly window: RateLimitWindowKind; readonly capacity: number }>;
    readonly tokens?: number;
  }): Promise<{
    readonly allowed: boolean;
    readonly retryAfterMs: number;
    readonly limitingWindow: RateLimitWindowKind | 'all';
  }> {
    const tokens = args.tokens ?? 1;
    const nowMs = this.now().getTime();

    // First, refill every bucket without consuming. This lets us discover
    // whether all buckets have capacity BEFORE we mutate any of them — the
    // operation must be all-or-nothing across windows.
    const refilled: Array<{ window: RateLimitWindowKind; state: BucketState }> = [];
    for (const b of args.buckets) {
      const state = this.refill(args.tenantId, args.actionClass, b.window, b.capacity, nowMs);
      refilled.push({ window: b.window, state });
    }

    // Find the most-constrained window (smallest current token pool relative
    // to capacity).
    for (const r of refilled) {
      if (r.state.tokens < tokens) {
        const refillRate = r.state.capacity / WINDOW_MS[r.window]; // tokens/ms
        const deficit = tokens - r.state.tokens;
        const retryAfterMs = refillRate > 0 ? Math.ceil(deficit / refillRate) : Number.POSITIVE_INFINITY;
        return { allowed: false, retryAfterMs, limitingWindow: r.window };
      }
    }

    // All buckets have capacity → commit the consumption.
    for (const r of refilled) {
      r.state.tokens -= tokens;
    }
    return { allowed: true, retryAfterMs: 0, limitingWindow: 'all' };
  }

  async consumption(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly capacities: { readonly minute: number; readonly hour: number; readonly day: number };
  }): Promise<RateLimitConsumption> {
    const nowMs = this.now().getTime();
    const minute = this.refill(args.tenantId, args.actionClass, 'minute', args.capacities.minute, nowMs);
    const hour   = this.refill(args.tenantId, args.actionClass, 'hour',   args.capacities.hour,   nowMs);
    const day    = this.refill(args.tenantId, args.actionClass, 'day',    args.capacities.day,    nowMs);
    return {
      minute: { used: minute.capacity - minute.tokens, capacity: minute.capacity },
      hour:   { used: hour.capacity   - hour.tokens,   capacity: hour.capacity   },
      day:    { used: day.capacity    - day.tokens,    capacity: day.capacity    },
    };
  }

  /** Test helper: clear all in-memory state. */
  reset(): void {
    this.buckets.clear();
  }

  private refill(
    tenantId: string,
    actionClass: string,
    window: RateLimitWindowKind,
    capacity: number,
    nowMs: number,
  ): BucketState {
    const key = `${tenantId}:${actionClass}:${window}`;
    let state = this.buckets.get(key);
    if (!state) {
      state = { capacity, tokens: capacity, lastRefillMs: nowMs };
      this.buckets.set(key, state);
      return state;
    }
    // If capacity has changed (e.g. cold-start ramped down a multiplier),
    // clip tokens to the new capacity but don't reset them up.
    if (state.capacity !== capacity) {
      state.capacity = capacity;
      if (state.tokens > capacity) state.tokens = capacity;
    }
    const elapsed = nowMs - state.lastRefillMs;
    if (elapsed > 0 && state.tokens < state.capacity) {
      const refillRate = state.capacity / WINDOW_MS[window]; // tokens/ms
      state.tokens = Math.min(state.capacity, state.tokens + refillRate * elapsed);
    }
    state.lastRefillMs = nowMs;
    return state;
  }
}
