/**
 * S.2: RateLimiter — composes policy + token bucket + cold-start scaler.
 *
 * Hot path: `tryConsume()` is called from `ActionTrustLadder.gate()` after
 * class resolution but before the trust-mode decision. Returns one of:
 *   - allowed  — request fits; gate continues to normal flow
 *   - soft     — bucket empty under 'soft' enforcement; caller backs off
 *   - hard     — bucket empty under 'hard' enforcement; caller aborts
 *
 * Event logging (`oweibo.rate_limit_events`) is best-effort and fire-and-
 * forget — never blocks the gate. Sustained-burst detection (logging when
 * a tenant approaches their burst allowance) is reserved for a follow-up
 * observability tick.
 *
 * Tenant `created_at` lookup is cached briefly (default 60 s) to avoid a
 * DB roundtrip on every action.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ITokenBucketStore,
  RateLimitPolicy,
  RateLimitWindowKind,
} from '@oweibo/core-contracts';
import { RateLimitPolicyResolver, applyColdStart } from './RateLimitPolicy.js';

export interface RateLimiterOptions {
  /** Default: env('ACTION_RATE_LIMITING_ENABLED') === 'true' */
  isEnabled?: () => boolean;
  /** Override clock; tests pin time. */
  now?: () => Date;
  /** Cache TTL for tenant.created_at lookups. Default 60 s. */
  tenantCacheTtlMs?: number;
  /** Optional log sink for fire-and-forget event logging failures. */
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

export type RateLimitDecision =
  | { kind: 'allowed' }
  | { kind: 'soft'; retryAfterMs: number; limitingWindow: RateLimitWindowKind }
  | { kind: 'hard'; reason: string };

interface TenantCacheEntry {
  createdAt: Date;
  cachedAtMs: number;
}

const DEFAULT_TENANT_CACHE_TTL_MS = 60 * 1000;

export class RateLimiter {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly tenantCacheTtlMs: number;
  private readonly log: NonNullable<RateLimiterOptions['log']>;
  private readonly tenantCache = new Map<string, TenantCacheEntry>();
  private readonly resolver: RateLimitPolicyResolver;

  constructor(
    private readonly pool: Pool,
    private readonly store: ITokenBucketStore,
    opts: RateLimiterOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.tenantCacheTtlMs = opts.tenantCacheTtlMs ?? DEFAULT_TENANT_CACHE_TTL_MS;
    this.log = opts.log ?? (() => undefined);
    this.resolver = new RateLimitPolicyResolver(pool, { now: opts.now });
  }

  /**
   * Try to consume 1 token from each of the three windows for (tenantId,
   * actionClass). When the flag is off, always 'allowed' (byte-identical
   * to today's behaviour).
   */
  async tryConsume(tenantId: string, actionClass: string): Promise<RateLimitDecision> {
    if (!this.isEnabled()) return { kind: 'allowed' };

    const policy = await this.resolver.resolve(tenantId, actionClass);
    const createdAt = await this.loadTenantCreatedAt(tenantId);
    const now = this.now();

    const capacities = this.effectiveCapacities(policy, createdAt, now);

    const r = await this.store.tryConsume({
      tenantId,
      actionClass,
      buckets: [
        { window: 'minute', capacity: capacities.minute },
        { window: 'hour',   capacity: capacities.hour   },
        { window: 'day',    capacity: capacities.day    },
      ],
    });

    if (r.allowed) return { kind: 'allowed' };

    // Cap retry hint at the policy's per-day refill at most; long waits
    // become a hard fail at the caller anyway.
    const retryAfterMs = Math.min(r.retryAfterMs, 24 * 60 * 60 * 1000);
    const window = r.limitingWindow as RateLimitWindowKind;

    void this.logEvent(
      tenantId,
      actionClass,
      window,
      policy.enforcementMode === 'hard' ? 'throttled_hard' : 'throttled_soft',
      { retryAfterMs },
    );

    if (policy.enforcementMode === 'hard') {
      return { kind: 'hard', reason: 'rate_limit_exceeded' };
    }
    return { kind: 'soft', retryAfterMs, limitingWindow: window };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Cap capacities by cold-start ramp and burst allowance. Burst is added
   * to the per-minute bucket only — it's a short-term flow control concept,
   * not a long-window concept.
   */
  private effectiveCapacities(
    policy: RateLimitPolicy,
    tenantCreatedAt: Date,
    now: Date,
  ): { minute: number; hour: number; day: number } {
    const perMinute = applyColdStart(policy.perMinute + policy.burstAllowance, policy, tenantCreatedAt, now);
    const perHour   = applyColdStart(policy.perHour,                          policy, tenantCreatedAt, now);
    const perDay    = applyColdStart(policy.perDay,                           policy, tenantCreatedAt, now);
    return {
      minute: Math.max(1, perMinute),
      hour:   Math.max(1, perHour),
      day:    Math.max(1, perDay),
    };
  }

  private async loadTenantCreatedAt(tenantId: string): Promise<Date> {
    const cached = this.tenantCache.get(tenantId);
    const nowMs = this.now().getTime();
    if (cached && nowMs - cached.cachedAtMs < this.tenantCacheTtlMs) {
      return cached.createdAt;
    }
    const client = await this.pool.connect();
    try {
      // Platform-admin scope so we can read tenants.created_at without RLS.
      await client.query(`SET LOCAL app.is_platform_admin = 'true'`);
      const r = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM oweibo.tenants WHERE id = $1::uuid LIMIT 1`,
        [tenantId],
      );
      const createdAt = r.rows[0]?.created_at ?? new Date(0);
      this.tenantCache.set(tenantId, { createdAt, cachedAtMs: nowMs });
      return createdAt;
    } finally {
      client.release();
    }
  }

  private async logEvent(
    tenantId: string,
    actionClass: string,
    window: RateLimitWindowKind,
    eventKind: 'throttled_soft' | 'throttled_hard' | 'sustained_burst',
    context: Record<string, unknown>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      await client.query(
        `INSERT INTO oweibo.rate_limit_events
           (tenant_id, action_class, window_kind, event_kind, context)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
        [tenantId, actionClass, window, eventKind, JSON.stringify(context)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.log('warn', 'RateLimiter event log failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }
}

function defaultEnabled(): boolean {
  return process.env.ACTION_RATE_LIMITING_ENABLED === 'true';
}

export type { PoolClient };
