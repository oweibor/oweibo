/**
 * T.3.a / T.8: PriorsAggregator — nightly cron computes platform-wide bandit
 * priors from existing per-tenant arms with K-anonymity enforced.
 *
 * Algorithm (per prompt-slot scope):
 *   1. SELECT alpha_sum, beta_sum, contributor_count grouped by
 *      (role, slot_id, channel, home_region) over arms whose contributing
 *      tenants had completed tasks in the last 90 days.
 *   2. HAVING contributor_count >= K_ANONYMITY (default 5).
 *   3. Re-normalise alpha_sum + beta_sum so the prior strength is capped
 *      at PRIOR_STRENGTH_CAP (default 50). Prevents a saturated prior from
 *      dominating a tenant's first ~50 observations.
 *   4. UPSERT into oweibo.platform_bandit_priors keyed on
 *      (scope_kind, scope_key, home_region).
 *   5. Separately, run the global aggregation (no region GROUP BY) and
 *      upsert as home_region='*' when the global pool clears K — used as
 *      fallback when a tenant's region has no row.
 *
 * Mode coupling: ttv.md says the aggregator declares operation type
 * 'bandit_priors_aggregation' and is disabled at Mode <= 3. We accept an
 * optional isAllowed() predicate that the runtime wires to
 * OperationalModeService — the predicate is consulted before each tick.
 *
 * Idempotency: re-running on the same dataset overwrites existing rows
 * with identical content. Skipped rows (below K) are deleted so a once-
 * eligible scope that drops below K stops serving stale priors.
 */
import type { Pool } from 'pg';

export interface PriorsAggregatorOptions {
  /** Minimum distinct contributors required to publish a prior. Default 5. */
  kAnonymity?: number;
  /** Cap on max(alpha_sum, beta_sum). Default 50. */
  priorStrengthCap?: number;
  /** Window for "active" arms. Default 90 days. */
  windowDays?: number;
  /** Returns true when the aggregator is allowed to run (mode gate). */
  isAllowed?: () => Promise<boolean>;
  /** Override clock; used by tests. */
  now?: () => Date;
  /** Optional logger. */
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

export interface AggregationResult {
  /** Number of scope rows upserted (matched K-anonymity). */
  readonly upserted: number;
  /** Number of scope rows deleted (fell below K since last run). */
  readonly deleted: number;
  /** Number of input groups filtered out by K-anonymity. */
  readonly filteredByKAnonymity: number;
}

const DEFAULT_K = 5;
const DEFAULT_CAP = 50;
const DEFAULT_WINDOW_DAYS = 90;

interface AggregatedRow {
  scope_kind: 'prompt_slot' | 'model_tier';
  scope_key: string;
  /** T.8: '*' for the platform-neutral global pool; concrete region otherwise. */
  home_region: string;
  alpha_sum: number;
  beta_sum: number;
  contributor_count: number;
}

export class PriorsAggregator {
  private readonly kAnonymity: number;
  private readonly cap: number;
  private readonly windowDays: number;
  private readonly isAllowed: () => Promise<boolean>;
  private readonly now: () => Date;
  private readonly log: NonNullable<PriorsAggregatorOptions['log']>;

  constructor(private readonly pool: Pool, opts: PriorsAggregatorOptions = {}) {
    this.kAnonymity = opts.kAnonymity ?? DEFAULT_K;
    this.cap = opts.priorStrengthCap ?? DEFAULT_CAP;
    this.windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
    this.isAllowed = opts.isAllowed ?? (async () => true);
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? defaultLog;
  }

  async runOnce(): Promise<AggregationResult> {
    const allowed = await this.isAllowed();
    if (!allowed) {
      this.log('info', 'PriorsAggregator skipped — operational mode disallows');
      return { upserted: 0, deleted: 0, filteredByKAnonymity: 0 };
    }

    const catalogVersion = this.now().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE platform_priors_writer`).catch(() => undefined);

      // T.8: per-region aggregation. Each tenant's home_region pins the row
      // it contributes to. EU-only tenants only feed the eu-* rows; the
      // global '*' row is computed separately below.
      const perRegion = await client.query<{
        scope_key: string;
        home_region: string;
        alpha_sum: string;
        beta_sum: string;
        contributor_count: string;
      }>(
        `SELECT
           pv.role || ':' || ba.slot_id || ':' || ba.channel AS scope_key,
           COALESCE(tn.home_region, '*')                      AS home_region,
           SUM(ba.alpha)::text                                AS alpha_sum,
           SUM(ba.beta)::text                                 AS beta_sum,
           COUNT(DISTINCT t.tenant_id)::text                  AS contributor_count
         FROM oweibo.bandit_arms ba
         JOIN oweibo.prompt_versions pv ON pv.hash = ba.prompt_hash
         JOIN oweibo.bandit_arm_events bae
              ON bae.slot_id = ba.slot_id AND bae.arm_id = ba.arm_id
         JOIN oweibo.tasks t ON t.id::text = bae.task_id
         JOIN oweibo.tenants tn ON tn.id = t.tenant_id
         WHERE t.completed_at > NOW() - ($1 || ' days')::INTERVAL
         GROUP BY pv.role, ba.slot_id, ba.channel, tn.home_region`,
        [String(this.windowDays)],
      );

      // Global pool — same aggregation without the region GROUP BY. The
      // resulting rows are written under home_region='*' as fallback for
      // tenants whose specific region didn't clear K.
      const global = await client.query<{
        scope_key: string;
        alpha_sum: string;
        beta_sum: string;
        contributor_count: string;
      }>(
        `SELECT
           pv.role || ':' || ba.slot_id || ':' || ba.channel AS scope_key,
           SUM(ba.alpha)::text                                AS alpha_sum,
           SUM(ba.beta)::text                                 AS beta_sum,
           COUNT(DISTINCT t.tenant_id)::text                  AS contributor_count
         FROM oweibo.bandit_arms ba
         JOIN oweibo.prompt_versions pv ON pv.hash = ba.prompt_hash
         JOIN oweibo.bandit_arm_events bae
              ON bae.slot_id = ba.slot_id AND bae.arm_id = ba.arm_id
         JOIN oweibo.tasks t ON t.id::text = bae.task_id
         WHERE t.completed_at > NOW() - ($1 || ' days')::INTERVAL
         GROUP BY pv.role, ba.slot_id, ba.channel`,
        [String(this.windowDays)],
      );

      const rows: AggregatedRow[] = [];
      for (const r of perRegion.rows) {
        rows.push({
          scope_kind: 'prompt_slot',
          scope_key: r.scope_key,
          home_region: r.home_region || '*',
          alpha_sum: Number(r.alpha_sum),
          beta_sum: Number(r.beta_sum),
          contributor_count: Number(r.contributor_count),
        });
      }
      for (const r of global.rows) {
        rows.push({
          scope_kind: 'prompt_slot',
          scope_key: r.scope_key,
          home_region: '*',
          alpha_sum: Number(r.alpha_sum),
          beta_sum: Number(r.beta_sum),
          contributor_count: Number(r.contributor_count),
        });
      }

      const eligible: AggregatedRow[] = [];
      let filtered = 0;
      for (const row of rows) {
        if (row.contributor_count >= this.kAnonymity) {
          eligible.push(applyStrengthCap(row, this.cap));
        } else {
          filtered += 1;
        }
      }

      // Upsert eligible rows. ON CONFLICT now keys on (scope_kind, scope_key,
      // home_region).
      let upserted = 0;
      for (const row of eligible) {
        await client.query(
          `INSERT INTO oweibo.platform_bandit_priors
             (scope_kind, scope_key, home_region, alpha_sum, beta_sum,
              contributor_count, catalog_version, computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (scope_kind, scope_key, home_region) DO UPDATE
             SET alpha_sum         = EXCLUDED.alpha_sum,
                 beta_sum          = EXCLUDED.beta_sum,
                 contributor_count = EXCLUDED.contributor_count,
                 catalog_version   = EXCLUDED.catalog_version,
                 computed_at       = NOW()`,
          [
            row.scope_kind,
            row.scope_key,
            row.home_region,
            row.alpha_sum,
            row.beta_sum,
            row.contributor_count,
            catalogVersion,
          ],
        );
        upserted += 1;
      }

      // Delete rows that are no longer in the eligible set. Composite key
      // now includes home_region.
      const eligibleKeys = new Set(
        eligible.map((r) => `${r.scope_kind}:${r.scope_key}:${r.home_region}`),
      );
      const allRows = await client.query<{
        scope_kind: string;
        scope_key: string;
        home_region: string;
      }>(
        `SELECT scope_kind, scope_key, home_region
           FROM oweibo.platform_bandit_priors
          WHERE scope_kind = 'prompt_slot'`,
      );
      let deleted = 0;
      for (const row of allRows.rows) {
        const key = `${row.scope_kind}:${row.scope_key}:${row.home_region}`;
        if (!eligibleKeys.has(key)) {
          await client.query(
            `DELETE FROM oweibo.platform_bandit_priors
              WHERE scope_kind = $1 AND scope_key = $2 AND home_region = $3`,
            [row.scope_kind, row.scope_key, row.home_region],
          );
          deleted += 1;
        }
      }

      await client.query('COMMIT');
      this.log('info', 'PriorsAggregator complete', { upserted, deleted, filteredByKAnonymity: filtered });
      return { upserted, deleted, filteredByKAnonymity: filtered };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.log('error', 'PriorsAggregator failed', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Re-normalise alpha + beta so neither exceeds the cap. Preserves the ratio
 * alpha / beta (which is the prior's belief about success rate) while
 * shrinking the absolute strength.
 */
export function applyStrengthCap(row: AggregatedRow, cap: number): AggregatedRow {
  const maxStrength = Math.max(row.alpha_sum, row.beta_sum);
  if (maxStrength <= cap) return row;
  const scale = cap / maxStrength;
  return {
    ...row,
    alpha_sum: row.alpha_sum * scale,
    beta_sum: row.beta_sum * scale,
  };
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === 'error') console.error(`[PriorsAggregator] ${line}`);
  else if (level === 'warn') console.warn(`[PriorsAggregator] ${line}`);
  else console.log(`[PriorsAggregator] ${line}`);
}
