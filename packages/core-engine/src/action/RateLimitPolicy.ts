/**
 * S.2: RateLimitPolicy resolver + default matrix.
 *
 * Resolution order:
 *   1. tenant + exact actionClass row in oweibo.rate_limit_policies
 *   2. tenant + '*' default row
 *   3. PLATFORM_DEFAULT_MATRIX entry (longest-prefix match)
 *   4. PLATFORM_FALLBACK (very-conservative)
 *
 * Cold-start multiplier: tightens budgets during the first N days. The
 * transition out is a *linear ramp* from `coldStartMultiplier` back to
 * 1.0 over the final 50% of the cold-start window, so tenants don't
 * experience a sudden 10× jump on day N.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ActionClass,
  RateLimitPolicy,
  RateLimitEnforcementMode,
} from '@oweibo/core-contracts';

// ── Default matrix ────────────────────────────────────────────────────────

interface DefaultEntry {
  perMinute: number;
  perHour: number;
  perDay: number;
  burstAllowance: number;
  coldStartMultiplier: number;
  coldStartDurationDays: number;
  enforcementMode: RateLimitEnforcementMode;
}

const PLATFORM_DEFAULT_MATRIX: ReadonlyArray<{ prefix: string; entry: DefaultEntry }> = [
  { prefix: 'irreversible.',     entry: { perMinute: 2,   perHour: 20,   perDay: 50,     burstAllowance: 1,   coldStartMultiplier: 0.05, coldStartDurationDays: 30, enforcementMode: 'hard' } },
  { prefix: 'financial.',        entry: { perMinute: 5,   perHour: 50,   perDay: 200,    burstAllowance: 2,   coldStartMultiplier: 0.10, coldStartDurationDays: 30, enforcementMode: 'soft' } },
  { prefix: 'personnel.',        entry: { perMinute: 5,   perHour: 50,   perDay: 200,    burstAllowance: 2,   coldStartMultiplier: 0.10, coldStartDurationDays: 30, enforcementMode: 'soft' } },
  { prefix: 'comm.',             entry: { perMinute: 10,  perHour: 200,  perDay: 1_000,  burstAllowance: 5,   coldStartMultiplier: 0.20, coldStartDurationDays: 14, enforcementMode: 'soft' } },
  { prefix: 'deploy.',           entry: { perMinute: 10,  perHour: 100,  perDay: 500,    burstAllowance: 5,   coldStartMultiplier: 0.10, coldStartDurationDays: 14, enforcementMode: 'soft' } },
  { prefix: 'write.external_api.', entry: { perMinute: 30, perHour: 600, perDay: 5_000,  burstAllowance: 15,  coldStartMultiplier: 0.25, coldStartDurationDays: 14, enforcementMode: 'soft' } },
  { prefix: 'write.tenant_db.',  entry: { perMinute: 60,  perHour: 1_200, perDay: 10_000, burstAllowance: 30,  coldStartMultiplier: 0.25, coldStartDurationDays: 14, enforcementMode: 'soft' } },
  { prefix: 'write.local.repo_', entry: { perMinute: 60,  perHour: 1_800, perDay: 20_000, burstAllowance: 30,  coldStartMultiplier: 0.25, coldStartDurationDays: 14, enforcementMode: 'soft' } },
  { prefix: 'write.local.scratch', entry: { perMinute: 200, perHour: 10_000, perDay: 100_000, burstAllowance: 100, coldStartMultiplier: 0.50, coldStartDurationDays: 7, enforcementMode: 'soft' } },
  { prefix: 'read.',             entry: { perMinute: 600, perHour: 30_000, perDay: 500_000, burstAllowance: 200, coldStartMultiplier: 0.50, coldStartDurationDays: 7, enforcementMode: 'soft' } },
];

const PLATFORM_FALLBACK: DefaultEntry = {
  perMinute: 10, perHour: 100, perDay: 500,
  burstAllowance: 5,
  coldStartMultiplier: 0.20,
  coldStartDurationDays: 14,
  enforcementMode: 'soft',
};

export function platformDefaultRateLimit(
  tenantId: string,
  actionClass: string,
): RateLimitPolicy {
  let entry: DefaultEntry = PLATFORM_FALLBACK;
  let matchLen = 0;
  for (const { prefix, entry: e } of PLATFORM_DEFAULT_MATRIX) {
    if (actionClass.startsWith(prefix) && prefix.length > matchLen) {
      entry = e;
      matchLen = prefix.length;
    }
  }
  // actionClass arrives as bare string; matched-by-prefix above means it
  // structurally satisfies ActionClass | '*'. Cast at the boundary so
  // downstream consumers see the constrained type.
  return { tenantId, actionClass: actionClass as ActionClass | '*', ...entry };
}

// ── Cold-start scaler ──────────────────────────────────────────────────────

/**
 * Apply the cold-start ramp to a single capacity. During the first half of
 * the cold-start window the multiplier is fixed at `coldStartMultiplier`;
 * during the second half it ramps linearly from `coldStartMultiplier` to
 * `1.0`. After the window, returns the raw capacity.
 *
 * Returns `Math.floor(capacity * multiplier)` so callers never have to
 * round; capacity stays integer-valued.
 */
export function applyColdStart(
  capacity: number,
  policy: Pick<RateLimitPolicy, 'coldStartMultiplier' | 'coldStartDurationDays'>,
  tenantCreatedAt: Date,
  now: Date,
): number {
  const days = (now.getTime() - tenantCreatedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (policy.coldStartDurationDays <= 0 || days >= policy.coldStartDurationDays) {
    return capacity;
  }
  if (days <= policy.coldStartDurationDays / 2) {
    return Math.max(1, Math.floor(capacity * policy.coldStartMultiplier));
  }
  // Linear ramp: at day = N/2 → multiplier; at day = N → 1.0
  const N = policy.coldStartDurationDays;
  const ramp = (days - N / 2) / (N / 2); // 0..1 across the second half
  const eff = policy.coldStartMultiplier + ramp * (1 - policy.coldStartMultiplier);
  return Math.max(1, Math.floor(capacity * eff));
}

// ── DB resolver ────────────────────────────────────────────────────────────

export interface PolicyResolverOptions {
  now?: () => Date;
}

export class RateLimitPolicyResolver {
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: PolicyResolverOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Resolve the effective policy for (tenantId, actionClass). Reads exact
   * row first, then '*', then falls back to the platform matrix.
   */
  async resolve(tenantId: string, actionClass: string): Promise<RateLimitPolicy> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      const r = await client.query<{
        action_class: string;
        per_minute: number;
        per_hour: number;
        per_day: number;
        burst_allowance: number;
        cold_start_multiplier: string;
        cold_start_duration_days: number;
        enforcement_mode: string;
      }>(
        `SELECT action_class, per_minute, per_hour, per_day, burst_allowance,
                cold_start_multiplier, cold_start_duration_days, enforcement_mode
           FROM oweibo.rate_limit_policies
          WHERE tenant_id = $1::uuid AND action_class IN ($2, '*')
          ORDER BY (action_class = $2) DESC
          LIMIT 1`,
        [tenantId, actionClass],
      );
      await client.query('COMMIT');
      const row = r.rows[0];
      if (!row) return platformDefaultRateLimit(tenantId, actionClass);
      return {
        tenantId,
        actionClass: row.action_class as ActionClass | '*',
        perMinute: row.per_minute,
        perHour: row.per_hour,
        perDay: row.per_day,
        burstAllowance: row.burst_allowance,
        coldStartMultiplier: Number(row.cold_start_multiplier),
        coldStartDurationDays: row.cold_start_duration_days,
        enforcementMode: row.enforcement_mode as RateLimitEnforcementMode,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export type { PoolClient };
