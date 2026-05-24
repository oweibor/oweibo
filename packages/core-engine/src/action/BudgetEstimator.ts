/**
 * S.6: BudgetEstimator — returns USD-cents cost estimate for an action
 * about to be gated. Three-tier resolver:
 *
 *   1. Per-tenant historical cost for (actionClass, capabilityId, sizeBucket)
 *      — most personalized; requires ≥ 30 observations to qualify.
 *   2. Platform-wide cost priors for the same key — K-anonymity floor
 *      ≥ 5 contributors (T.3.a / T.8 region segmentation).
 *   3. Hand-tuned defaults from budget-defaults.ts — always returns
 *      something so the gate never blocks for a missing estimate.
 *
 * Tenant override: `features.budget_estimator.aggressive=true` opts the
 * tenant into the p50 (median) percentile instead of the conservative
 * p95 default. Trade-off: better median accuracy, more false negatives
 * (under-estimates) for long-tail expensive actions.
 *
 * The estimator caches per-(tenant, class, capability, bucket) lookups
 * for 60 s — the gate calls this on every action and a DB round-trip
 * per gate is unacceptable on the hot path.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ActionClass,
  BudgetEstimate,
  IBudgetEstimator,
  PayloadSizeBucket,
} from '@oweibo/core-contracts';
import { bucketPayloadSize } from '@oweibo/core-contracts';
import { platformBudgetDefault } from './budget-defaults.js';

const TENANT_HISTORY_MIN_OBS = 30;
const CACHE_TTL_MS = 60_000;

interface CachedEstimate {
  readonly estimate: BudgetEstimate;
  readonly expiresAtMs: number;
}

export interface BudgetEstimatorOptions {
  /** Override clock; tests pin time. */
  now?: () => Date;
  /**
   * When true (per tenant), the estimator returns p50 (median) instead
   * of p95. Defaults to false. The resolver is passed the tenantId.
   */
  aggressiveForTenant?: (tenantId: string) => Promise<boolean>;
}

export class BudgetEstimator implements IBudgetEstimator {
  private readonly cache = new Map<string, CachedEstimate>();
  private readonly now: () => Date;
  private readonly aggressiveForTenant: (tenantId: string) => Promise<boolean>;

  constructor(private readonly pool: Pool, opts: BudgetEstimatorOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.aggressiveForTenant = opts.aggressiveForTenant ?? (async () => false);
  }

  async estimate(args: {
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    readonly capabilityId?: string;
    readonly payload?: unknown;
    readonly homeRegion?: string;
  }): Promise<BudgetEstimate> {
    const capabilityId = args.capabilityId ?? '*';
    const sizeBucket = bucketPayloadFromUnknown(args.payload);
    const cacheKey = `${args.tenantId}::${args.actionClass}::${capabilityId}::${sizeBucket}::${args.homeRegion ?? '*'}`;
    const cached = this.cache.get(cacheKey);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.estimate;
    }

    const aggressive = await this.aggressiveForTenant(args.tenantId);
    const estimate = await this.resolve(args.tenantId, args.actionClass, capabilityId, sizeBucket, args.homeRegion, aggressive);
    this.cache.set(cacheKey, { estimate, expiresAtMs: nowMs + CACHE_TTL_MS });
    return estimate;
  }

  // ── Tiered resolver ─────────────────────────────────────────────────────

  private async resolve(
    tenantId: string,
    actionClass: ActionClass,
    capabilityId: string,
    sizeBucket: PayloadSizeBucket,
    homeRegion: string | undefined,
    aggressive: boolean,
  ): Promise<BudgetEstimate> {
    // Tier 1: tenant history.
    const tenant = await this.lookupTenantHistory(tenantId, actionClass, capabilityId, sizeBucket, aggressive);
    if (tenant !== null) {
      return {
        costUsdCents: tenant,
        source: 'tenant_history',
        confidence: 'high',
        capabilityId,
        payloadSizeBucket: sizeBucket,
      };
    }
    // Tier 2: platform priors.
    const prior = await this.lookupPlatformPrior(actionClass, capabilityId, sizeBucket, homeRegion, aggressive);
    if (prior !== null) {
      return {
        costUsdCents: prior,
        source: 'platform_prior',
        confidence: 'medium',
        capabilityId,
        payloadSizeBucket: sizeBucket,
      };
    }
    // Tier 3: hand-tuned defaults.
    return {
      costUsdCents: platformBudgetDefault(actionClass),
      source: 'platform_default',
      confidence: 'low',
      capabilityId,
      payloadSizeBucket: sizeBucket,
    };
  }

  private async lookupTenantHistory(
    tenantId: string,
    actionClass: ActionClass,
    capabilityId: string,
    sizeBucket: PayloadSizeBucket,
    aggressive: boolean,
  ): Promise<number | null> {
    // Pulls from post_execution_verifications.observed_cost_cents (S.5).
    // p50 (aggressive) or p95 (conservative).
    return this.tx(tenantId, async (client) => {
      const percentileSql = aggressive
        ? `PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY observed_cost_cents)`
        : `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY observed_cost_cents)`;
      const r = await client.query<{ p: string | null; n: number }>(
        `SELECT ${percentileSql} AS p, COUNT(*)::int AS n
           FROM oweibo.post_execution_verifications
          WHERE tenant_id = $1::uuid
            AND observed_cost_cents IS NOT NULL
            AND verified_at > NOW() - INTERVAL '90 days'
            AND (notes IS NULL OR notes NOT LIKE 'verifier_error%')
            AND proposal_id IN (
              SELECT id FROM oweibo.action_proposals
               WHERE action_class = $2
            )`,
        [tenantId, actionClass],
      );
      const row = r.rows[0];
      if (!row || row.n < TENANT_HISTORY_MIN_OBS || row.p === null) return null;
      // capability_id + size_bucket aren't yet recorded on
      // post_execution_verifications (deferred to S.6 follow-up); for now
      // we aggregate across all (capability, bucket) for this class. Once
      // those columns are added, the WHERE clause tightens further.
      void capabilityId; void sizeBucket;
      return Math.max(0, Math.floor(Number(row.p)));
    });
  }

  private async lookupPlatformPrior(
    actionClass: ActionClass,
    capabilityId: string,
    sizeBucket: PayloadSizeBucket,
    homeRegion: string | undefined,
    aggressive: boolean,
  ): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      // Platform-wide table — read does not need tenant scope.
      const r = await client.query<{
        p50_cents: number;
        p95_cents: number;
        contributor_count: number;
        home_region: string;
      }>(
        // Prefer region-specific row when present; fall through to '*' (global).
        `SELECT p50_cents, p95_cents, contributor_count, home_region
           FROM oweibo.platform_action_cost_priors
          WHERE action_class = $1 AND capability_id = $2 AND payload_size_bucket = $3
            AND home_region IN ($4, '*')
          ORDER BY (home_region = $4) DESC
          LIMIT 1`,
        [actionClass, capabilityId, sizeBucket, homeRegion ?? '*'],
      );
      const row = r.rows[0];
      if (!row || row.contributor_count < 5) return null;
      return aggressive ? row.p50_cents : row.p95_cents;
    } finally {
      client.release();
    }
  }

  // ── tx helper ────────────────────────────────────────────────────────────

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

function bucketPayloadFromUnknown(payload: unknown): PayloadSizeBucket {
  if (payload === undefined || payload === null) return 'xs';
  let n: number;
  try {
    n = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    n = 256;
  }
  return bucketPayloadSize(n);
}
