/**
 * S.6: QuotaService — enforces absolute caps over day / month / year
 * windows, distinct from S.2 short-window rate limits.
 *
 * Flow per `preflight(args)`:
 *   1. Read all tenant quota_policies matching (kind ∈ matchingKinds, scope ∈ {actionClass, '*'})
 *      across windows {day, month, year}.
 *   2. For each matching policy:
 *        a. Compute current window_start (day = today UTC midnight,
 *           month = 1st of month, year = Jan 1).
 *        b. Read quota_consumption.consumed for (tenant, kind, scope, window_start).
 *        c. Compute pending = consumed + (this action's contribution).
 *        d. Apply cold-start ramp: limit = coldStartLimit when the
 *           tenant is younger than coldStartDurationDays AND
 *           coldStartLimit is set, else limit_value.
 *        e. If pending > limit:
 *             - hard enforcement → return {kind: 'deny', resetAt}
 *             - soft enforcement → continue but flag as soft_warn
 *        f. Else continue.
 *   3. Return worst-of result. allow > soft_warn > deny.
 *
 * `record(args)` is called by the executor (typically right after a
 * successful action). Updates run via UPSERT with `consumed = consumed
 * + delta` so concurrent records don't lose increments.
 *
 * Idempotency note: this service does NOT dedupe at the actionId level.
 * Callers wanting dedupe (e.g. retries through the same gate) must
 * gate `record()` on an external dedupe key. The trust ladder's
 * action_proposals.action_id uniqueness covers this for the normal
 * gate path.
 *
 * Concurrency note: preflight is check-then-act. To reduce the race
 * window between preflight and record(), loadConsumed locks the
 * (tenant, quota_kind, scope, window, window_start) row with FOR
 * UPDATE so concurrent preflights for the same key serialize. This
 * does NOT fully prevent two parallel actions from both passing
 * preflight (they hold the lock only during their own preflight
 * txn). For absolute caps on small limits (e.g. financial.payment
 * daily count = 5), enforce the limit at the gate layer with an
 * external reservation pattern.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ActionClass,
  IQuotaService,
  QuotaEnforcementMode,
  QuotaKind,
  QuotaPolicy,
  QuotaPreflightResult,
  QuotaWindow,
} from '@oweibo/core-contracts';
import { PolicyBelowFloorError, type PolicyFloorViolation } from './PolicyFloor.js';

interface PolicyRow {
  tenant_id: string;
  quota_kind: string;
  scope: string;
  window: string;
  limit_value: string;
  cold_start_limit: string | null;
  cold_start_duration_days: number;
  enforcement_mode: string;
}

export interface QuotaServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
  /**
   * Returns tenant account age in days. Used to apply cold-start ramps.
   * The trust ladder already resolves accountAgeDays in its calibration
   * snapshot — wire it through here to avoid a round-trip.
   */
  accountAgeResolver?: (tenantId: string) => Promise<number>;
}

export class QuotaService implements IQuotaService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly accountAgeResolver: (tenantId: string) => Promise<number>;

  constructor(private readonly pool: Pool, opts: QuotaServiceOptions = {}) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.accountAgeResolver = opts.accountAgeResolver ?? (async () => 365);
  }

  // ── preflight ───────────────────────────────────────────────────────────

  async preflight(args: {
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    readonly estimatedCostUsdCents?: number;
    readonly blastRadiusUsers?: number;
  }): Promise<QuotaPreflightResult> {
    if (!this.isEnabled()) return { kind: 'allow' };

    const policies = await this.loadMatchingPolicies(args.tenantId, args.actionClass);
    if (policies.length === 0) return { kind: 'allow' };

    const ageDays = await this.accountAgeResolver(args.tenantId);
    const now = this.now();

    let worst: QuotaPreflightResult = { kind: 'allow' };
    for (const policy of policies) {
      const delta = this.deltaFor(policy.quotaKind, args);
      // Audit-fix (S.0 #9 follow-through): a delta of 0 means either
      // "this kind doesn't apply" (e.g. blast_radius_user_count with no
      // blast supplied) OR "cost is unknown." Both safely skip the check
      // here — but for cost-kind quotas with unknown cost, the
      // BudgetEstimator should have filled in a conservative fallback
      // upstream. If it didn't, we skip; downstream telemetry should
      // count these as `quota_check_skipped_unknown_cost`.
      if (delta === 0) continue;
      const limit = effectiveLimit(policy, ageDays);
      const windowStart = windowStartFor(policy.window, now);
      const consumed = await this.loadConsumed(args.tenantId, policy, windowStart);
      const pending = consumed + delta;
      if (pending > limit) {
        const resetAt = nextResetAt(policy.window, now);
        if (policy.enforcementMode === 'hard') {
          return {
            kind: 'deny',
            quotaKind: policy.quotaKind,
            scope: policy.scope,
            window: policy.window,
            limit,
            consumed,
            resetAt,
          };
        }
        // soft
        worst = {
          kind: 'soft_warn',
          quotaKind: policy.quotaKind,
          scope: policy.scope,
          window: policy.window,
          limit,
          consumed,
          resetAt,
        };
      }
    }
    return worst;
  }

  // ── record ──────────────────────────────────────────────────────────────

  async record(args: {
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    readonly actualCostUsdCents?: number;
    readonly blastRadiusUsers?: number;
  }): Promise<void> {
    if (!this.isEnabled()) return;
    // Even without explicit policies, we always increment the consumption
    // counters for the standard kinds so a later policy-add picks up
    // real usage immediately (no warmup gap).
    const incrementsByKind: ReadonlyArray<{ kind: QuotaKind; scope: ActionClass | '*'; delta: number }> = [
      { kind: 'action_count_per_class', scope: args.actionClass, delta: 1 },
      { kind: 'total_actions',          scope: '*',              delta: 1 },
      ...(typeof args.actualCostUsdCents === 'number' && args.actualCostUsdCents > 0
        ? [
            { kind: 'usd_cost_per_class' as QuotaKind, scope: args.actionClass, delta: args.actualCostUsdCents },
            { kind: 'usd_cost_total'     as QuotaKind, scope: '*' as const,    delta: args.actualCostUsdCents },
          ]
        : []),
      ...(typeof args.blastRadiusUsers === 'number' && args.blastRadiusUsers > 0
        ? [{ kind: 'blast_radius_user_count' as QuotaKind, scope: '*' as const, delta: args.blastRadiusUsers }]
        : []),
    ];

    const now = this.now();
    await this.tx(args.tenantId, async (client) => {
      for (const inc of incrementsByKind) {
        // Increment per window: day, month, year (no policy required —
        // the counter exists irrespective of whether a policy caps it).
        for (const window of ['day', 'month', 'year'] as const) {
          const windowStart = windowStartFor(window, now);
          await client.query(
            `INSERT INTO oweibo.quota_consumption
               (tenant_id, quota_kind, scope, window_kind, window_start, consumed, updated_at)
             VALUES ($1::uuid, $2, $3, $4, $5::date, $6, NOW())
             ON CONFLICT (tenant_id, quota_kind, scope, window_kind, window_start) DO UPDATE
               SET consumed = oweibo.quota_consumption.consumed + EXCLUDED.consumed,
                   updated_at = NOW()`,
            [args.tenantId, inc.kind, inc.scope, window, windowStart, inc.delta],
          );
        }
      }
    });
  }

  // ── Read-only usage (admin UI) ──────────────────────────────────────────

  /**
   * Return the current consumed/limit for every (kind, scope, window)
   * the tenant has consumption rows for. Used by /actions/quotas/usage.
   * Optional actionClass filter narrows to '*' + that-class rows.
   */
  async usage(tenantId: string, actionClass?: string): Promise<readonly {
    quotaKind: string;
    scope: string;
    window: QuotaWindow;
    windowStart: string;
    consumed: number;
    limit: number | null;
    enforcementMode: 'hard' | 'soft' | null;
    resetAt: string;
  }[]> {
    const now = this.now();
    return this.tx(tenantId, async (client) => {
      const filter = actionClass ? `AND (c.scope = '*' OR c.scope = $2)` : '';
      const params: unknown[] = [tenantId];
      if (actionClass) params.push(actionClass);
      const r = await client.query<{
        quota_kind: string;
        scope: string;
        window: QuotaWindow;
        window_start: string;
        consumed: string;
        limit_value: string | null;
        cold_start_limit: string | null;
        cold_start_duration_days: number | null;
        enforcement_mode: 'hard' | 'soft' | null;
      }>(
        `SELECT
           c.quota_kind, c.scope, c.window_kind AS window, c.window_start::text AS window_start,
           c.consumed::text AS consumed,
           p.limit_value::text AS limit_value,
           p.cold_start_limit::text AS cold_start_limit,
           p.cold_start_duration_days,
           p.enforcement_mode
         FROM oweibo.quota_consumption c
         LEFT JOIN oweibo.quota_policies p
           ON p.tenant_id = c.tenant_id
          AND p.quota_kind = c.quota_kind
          AND p.scope = c.scope
          AND p.window_kind = c.window_kind
         WHERE c.tenant_id = $1::uuid ${filter}
         ORDER BY c.window_kind, c.quota_kind, c.scope
         LIMIT 500`,
        params,
      );
      const ageDays = await this.accountAgeResolver(tenantId);
      return r.rows.map((row) => {
        let limit: number | null = null;
        if (row.limit_value !== null) {
          const policy: QuotaPolicy = {
            tenantId,
            quotaKind: row.quota_kind as QuotaKind,
            scope: row.scope as ActionClass | '*',
            window: row.window,
            limitValue: Number(row.limit_value),
            ...(row.cold_start_limit !== null
              ? { coldStartLimit: Number(row.cold_start_limit) }
              : {}),
            coldStartDurationDays: row.cold_start_duration_days ?? 0,
            enforcementMode: (row.enforcement_mode ?? 'hard') as QuotaEnforcementMode,
          };
          limit = effectiveLimit(policy, ageDays);
        }
        return {
          quotaKind: row.quota_kind,
          scope: row.scope,
          window: row.window,
          windowStart: row.window_start,
          consumed: Number(row.consumed),
          limit,
          enforcementMode: row.enforcement_mode,
          resetAt: nextResetAt(row.window, now),
        };
      });
    });
  }

  // ── F.4.4: tenant policy override CRUD ─────────────────────────────────

  /**
   * List every tenant override row. Quotas are keyed by (kind, scope,
   * window) so a tenant may have multiple rows per actionClass scope.
   */
  async listPolicies(tenantId: string): Promise<readonly QuotaPolicy[]> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<PolicyRow>(
        `SELECT tenant_id, quota_kind, scope, window_kind AS window, limit_value,
                cold_start_limit, cold_start_duration_days, enforcement_mode
           FROM oweibo.quota_policies
          WHERE tenant_id = $1::uuid
          ORDER BY scope, window_kind, quota_kind`,
        [tenantId],
      );
      return r.rows.map<QuotaPolicy>((row) => ({
        tenantId: row.tenant_id,
        quotaKind: row.quota_kind as QuotaKind,
        scope: row.scope as ActionClass | '*',
        window: row.window as QuotaWindow,
        limitValue: Number(row.limit_value),
        ...(row.cold_start_limit !== null ? { coldStartLimit: Number(row.cold_start_limit) } : {}),
        coldStartDurationDays: row.cold_start_duration_days,
        enforcementMode: row.enforcement_mode as QuotaEnforcementMode,
      }));
    });
  }

  async upsertPolicy(
    tenantId: string,
    policy: Omit<QuotaPolicy, 'tenantId'>,
  ): Promise<QuotaPolicy> {
    const violations = checkQuotaPolicyAgainstFloor(policy);
    if (violations.length > 0) {
      throw new PolicyBelowFloorError('quota', policy.scope, violations);
    }
    return this.tx(tenantId, async (client) => {
      await client.query(
        `INSERT INTO oweibo.quota_policies
           (tenant_id, quota_kind, scope, window_kind, limit_value,
            cold_start_limit, cold_start_duration_days, enforcement_mode, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (tenant_id, quota_kind, scope, window_kind) DO UPDATE
           SET limit_value              = EXCLUDED.limit_value,
               cold_start_limit         = EXCLUDED.cold_start_limit,
               cold_start_duration_days = EXCLUDED.cold_start_duration_days,
               enforcement_mode         = EXCLUDED.enforcement_mode,
               updated_at               = NOW()`,
        [
          tenantId,
          policy.quotaKind,
          policy.scope,
          policy.window,
          policy.limitValue,
          policy.coldStartLimit ?? null,
          policy.coldStartDurationDays,
          policy.enforcementMode,
        ],
      );
      return { tenantId, ...policy };
    });
  }

  async deletePolicy(
    tenantId: string,
    key: { quotaKind: QuotaKind; scope: string; window: QuotaWindow },
  ): Promise<boolean> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query(
        `DELETE FROM oweibo.quota_policies
           WHERE tenant_id = $1::uuid
             AND quota_kind = $2
             AND scope = $3
             AND window_kind = $4`,
        [tenantId, key.quotaKind, key.scope, key.window],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async loadMatchingPolicies(tenantId: string, actionClass: ActionClass): Promise<QuotaPolicy[]> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<PolicyRow>(
        `SELECT tenant_id, quota_kind, scope, window_kind AS window, limit_value,
                cold_start_limit, cold_start_duration_days, enforcement_mode
           FROM oweibo.quota_policies
          WHERE tenant_id = $1::uuid AND scope IN ($2, '*')`,
        [tenantId, actionClass],
      );
      return r.rows.map<QuotaPolicy>((row) => ({
        tenantId: row.tenant_id,
        quotaKind: row.quota_kind as QuotaKind,
        scope: row.scope as ActionClass | '*',
        window: row.window as QuotaWindow,
        limitValue: Number(row.limit_value),
        ...(row.cold_start_limit !== null ? { coldStartLimit: Number(row.cold_start_limit) } : {}),
        coldStartDurationDays: row.cold_start_duration_days,
        enforcementMode: row.enforcement_mode as QuotaEnforcementMode,
      }));
    });
  }

  private async loadConsumed(tenantId: string, policy: QuotaPolicy, windowStart: string): Promise<number> {
    return this.tx(tenantId, async (client) => {
      // FOR UPDATE serialises concurrent preflights for the same
      // (tenant, kind, scope, window) — narrows but does not eliminate
      // the preflight→record race window. SKIP LOCKED would let a
      // concurrent caller skip past the lock and over-account; we want
      // them to wait so they see the latest consumed value.
      const r = await client.query<{ consumed: string }>(
        `SELECT consumed::text
           FROM oweibo.quota_consumption
          WHERE tenant_id = $1::uuid AND quota_kind = $2 AND scope = $3
            AND window_kind = $4 AND window_start = $5::date
          FOR UPDATE`,
        [tenantId, policy.quotaKind, policy.scope, policy.window, windowStart],
      );
      const row = r.rows[0];
      return row ? Number(row.consumed) : 0;
    });
  }

  private deltaFor(kind: QuotaKind, args: {
    readonly estimatedCostUsdCents?: number;
    readonly blastRadiusUsers?: number;
  }): number {
    switch (kind) {
      case 'action_count_per_class':
      case 'total_actions':
        return 1;
      case 'usd_cost_per_class':
      case 'usd_cost_total':
        // Round UP for cost-based deltas — flooring gave the tenant up
        // to <1¢ of slack per call which adds up across enterprise volumes.
        return Math.max(0, Math.ceil(args.estimatedCostUsdCents ?? 0));
      case 'blast_radius_user_count':
        return Math.max(0, Math.ceil(args.blastRadiusUsers ?? 0));
    }
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

// ── F.4.4: platform-floor matrix ────────────────────────────────────────

/**
 * Quotas are keyed by (kind, scope, window). The platform floors are
 * stated per-quota-row:
 *
 *   - `limitValue >= 1`           — a quota of zero would silently
 *                                   block every action of that
 *                                   class/window combination, which
 *                                   is indistinguishable from a bug.
 *   - `coldStartLimit >= 1`       — same reasoning when cold-start
 *                                   is configured. NULL coldStartLimit
 *                                   is allowed (means "no separate
 *                                   cold-start cap").
 *   - `coldStartDurationDays >= 0` — already enforced by the DB
 *                                   CHECK, mirrored here for early
 *                                   rejection.
 */
export const QUOTA_PLATFORM_MIN_MATRIX = {
  limitValueMin: 1,
  coldStartLimitMin: 1,
  coldStartDurationDaysMin: 0,
} as const;

export function checkQuotaPolicyAgainstFloor(
  policy: Pick<QuotaPolicy, 'limitValue' | 'coldStartLimit' | 'coldStartDurationDays'>,
): PolicyFloorViolation[] {
  const violations: PolicyFloorViolation[] = [];
  if (policy.limitValue < QUOTA_PLATFORM_MIN_MATRIX.limitValueMin) {
    violations.push({
      field: 'limitValue',
      message: `limitValue below the platform floor (${QUOTA_PLATFORM_MIN_MATRIX.limitValueMin})`,
      floor: QUOTA_PLATFORM_MIN_MATRIX.limitValueMin,
      supplied: policy.limitValue,
    });
  }
  if (policy.coldStartLimit !== undefined && policy.coldStartLimit !== null
    && policy.coldStartLimit < QUOTA_PLATFORM_MIN_MATRIX.coldStartLimitMin) {
    violations.push({
      field: 'coldStartLimit',
      message: `coldStartLimit below the platform floor (${QUOTA_PLATFORM_MIN_MATRIX.coldStartLimitMin})`,
      floor: QUOTA_PLATFORM_MIN_MATRIX.coldStartLimitMin,
      supplied: policy.coldStartLimit,
    });
  }
  if (policy.coldStartDurationDays < QUOTA_PLATFORM_MIN_MATRIX.coldStartDurationDaysMin) {
    violations.push({
      field: 'coldStartDurationDays',
      message: 'coldStartDurationDays cannot be negative',
      floor: QUOTA_PLATFORM_MIN_MATRIX.coldStartDurationDaysMin,
      supplied: policy.coldStartDurationDays,
    });
  }
  return violations;
}

function defaultEnabled(): boolean {
  return process.env.ACTION_QUOTAS_ENABLED === 'true';
}

/** Pick the effective limit for an account age, honoring cold_start. */
export function effectiveLimit(policy: QuotaPolicy, accountAgeDays: number): number {
  if (policy.coldStartLimit !== undefined && accountAgeDays < policy.coldStartDurationDays) {
    return policy.coldStartLimit;
  }
  return policy.limitValue;
}

/** Truncate a Date to the start of the given window (UTC). Returns yyyy-mm-dd. */
export function windowStartFor(window: QuotaWindow, at: Date): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  let date: Date;
  switch (window) {
    case 'day':   date = new Date(Date.UTC(y, m, d)); break;
    case 'month': date = new Date(Date.UTC(y, m, 1)); break;
    case 'year':  date = new Date(Date.UTC(y, 0, 1)); break;
  }
  return date.toISOString().slice(0, 10); // yyyy-mm-dd
}

/** Returns the ISO timestamp at which the current window resets (UTC). */
export function nextResetAt(window: QuotaWindow, at: Date): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  switch (window) {
    case 'day':   return new Date(Date.UTC(y, m, d + 1)).toISOString();
    case 'month': return new Date(Date.UTC(y, m + 1, 1)).toISOString();
    case 'year':  return new Date(Date.UTC(y + 1, 0, 1)).toISOString();
  }
}
