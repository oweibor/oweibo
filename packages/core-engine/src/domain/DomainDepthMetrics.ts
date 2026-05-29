/**
 * D.8 (domain-depth): DomainDepthMetrics — computes the composite
 * depth score and persists weekly snapshots.
 *
 * The composite formula is pure (no DB) and lives in
 * `computeCompositeScore()`. Tests exercise it directly with synthetic
 * inputs. The service wraps it with the DB write surface and the
 * hysteresis logic that recommends a maturity tier.
 *
 * Composite formula (per plan §4 D.8):
 *
 *   score = 0.20 × min(ontologyEntries     / target.ontologyEntries,    1) × 100
 *         + 0.20 × min(rubricCount         / target.rubricCount,        1) × 100
 *         + 0.20 × min(ruleCount           / target.ruleCount,          1) × 100
 *         + 0.15 × min(verifiedConnectors  / target.verifiedConnectors, 1) × 100
 *         + 0.15 × min(credentialedSmes    / target.credentialedSmes,   1) × 100
 *         + 0.10 × weeklyReviewActivityScore                               × 100
 *
 * Targets are read from `domain_catalog.depth_targets`. A target of 0
 * (or absent) makes that component contribute 0 — encourages explicit
 * target-setting rather than divide-by-zero defaults.
 *
 * Tier recommendation hysteresis:
 *   - advance to the next tier only after 4 consecutive snapshots
 *     above the upgrade threshold
 *   - regress to the prior tier only after 8 consecutive below
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ComplianceCoverage,
  ConnectorCoverage,
  DomainCatalogEntry,
  DomainDepthInputs,
  DomainDepthSnapshot,
  DomainMaturity,
  DomainSlug,
  EvalCoverage,
  OntologyCoverage,
  SmeCoverage,
  TenantDomainUtilizationSnapshot,
} from '@oweibo/core-contracts';

// ─── Pure composite-score helpers ───────────────────────────────────────

export interface DepthTargets {
  readonly ontologyEntries: number;
  readonly rubricCount: number;
  readonly ruleCount: number;
  readonly verifiedConnectors: number;
  readonly credentialedSmes: number;
}

const COMPONENT_WEIGHTS = {
  ontology: 0.2,
  rubric: 0.2,
  rule: 0.2,
  connector: 0.15,
  sme: 0.15,
  weeklyActivity: 0.1,
} as const;

const TIER_UPGRADE_THRESHOLDS: Record<DomainMaturity, number> = {
  experimental: 0,
  beta: 50,
  general_availability: 75,
  deprecated: Number.POSITIVE_INFINITY,
};

const TIER_ORDER: readonly DomainMaturity[] = [
  'experimental',
  'beta',
  'general_availability',
];

/**
 * Compute the composite score. Pure: no DB, no clock.
 *   - Each component is `min(actual/target, 1)` so over-saturation
 *     does not lift the score above the weighted ceiling.
 *   - target<=0 ⇒ component contributes 0 (encourages explicit targets).
 *   - weeklyReviewActivityScore is treated as already-normalised [0,1].
 */
export function computeCompositeScore(
  inputs: DomainDepthInputs,
  targets: DepthTargets,
): number {
  const part = (actual: number, target: number, weight: number): number =>
    target <= 0 ? 0 : weight * Math.min(actual / target, 1) * 100;

  const score =
    part(inputs.ontologyEntries, targets.ontologyEntries, COMPONENT_WEIGHTS.ontology) +
    part(inputs.rubricCount, targets.rubricCount, COMPONENT_WEIGHTS.rubric) +
    part(inputs.ruleCount, targets.ruleCount, COMPONENT_WEIGHTS.rule) +
    part(inputs.verifiedConnectors, targets.verifiedConnectors, COMPONENT_WEIGHTS.connector) +
    part(inputs.credentialedSmes, targets.credentialedSmes, COMPONENT_WEIGHTS.sme) +
    clamp01(inputs.weeklyReviewActivityScore) * COMPONENT_WEIGHTS.weeklyActivity * 100;

  return round2(clamp(score, 0, 100));
}

/**
 * Hysteresis-stabilised tier recommendation from a sequence of recent
 * scores (newest first). Returns the tier the platform admin would
 * see as the snapshot's `recommendedTier`.
 *
 *   - advance to the next tier only after >= 4 consecutive recent
 *     snapshots above the upgrade threshold for that tier
 *   - regress to the prior tier only after >= 8 consecutive below
 *
 * `currentTier` is the catalog's load-bearing tier (the
 * recommendation operates relative to it).
 */
export function recommendTier(args: {
  readonly currentTier: DomainMaturity;
  /** Score history, newest first. */
  readonly recentScores: readonly number[];
}): DomainMaturity {
  if (args.currentTier === 'deprecated') return 'deprecated';
  const recent = args.recentScores;
  if (recent.length === 0) return args.currentTier;

  const currentIdx = TIER_ORDER.indexOf(args.currentTier);
  const nextTier = TIER_ORDER[currentIdx + 1];

  // Advancement check
  if (nextTier) {
    const threshold = TIER_UPGRADE_THRESHOLDS[nextTier];
    const aboveStreak = leadingStreak(recent, (s) => s >= threshold);
    if (aboveStreak >= 4) return nextTier;
  }

  // Regression check
  if (currentIdx > 0) {
    const threshold = TIER_UPGRADE_THRESHOLDS[args.currentTier];
    const belowStreak = leadingStreak(recent, (s) => s < threshold);
    if (belowStreak >= 8) return TIER_ORDER[currentIdx - 1]!;
  }

  return args.currentTier;
}

function leadingStreak(xs: readonly number[], pred: (x: number) => boolean): number {
  let n = 0;
  for (const x of xs) {
    if (pred(x)) n++;
    else break;
  }
  return n;
}

// ─── Service ───────────────────────────────────────────────────────────

export interface PersistSnapshotInput {
  readonly domainSlug: DomainSlug;
  readonly compositeScore: number;
  readonly recommendedTier: DomainMaturity;
  readonly ontologyCoverage: OntologyCoverage;
  readonly evalCoverage: EvalCoverage;
  readonly complianceCoverage: ComplianceCoverage;
  readonly connectorCoverage: ConnectorCoverage;
  readonly smeCoverage: SmeCoverage;
}

export interface DomainDepthMetricsOptions {
  /** Default 'platform_admin'. */
  setLocalRole?: () => string;
  now?: () => Date;
}

export class DomainDepthMetrics {
  private readonly roleName: () => string;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: DomainDepthMetricsOptions = {}) {
    this.roleName = opts.setLocalRole ?? (() => 'platform_admin');
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Compute + persist a snapshot for a domain. The caller supplies
   * pre-aggregated inputs + coverages so the service doesn't have to
   * know about every registry's shape. Returns the snapshot row that
   * was persisted.
   */
  async writeSnapshot(args: {
    readonly catalogEntry: DomainCatalogEntry;
    readonly inputs: DomainDepthInputs;
    readonly coverages: {
      readonly ontology: OntologyCoverage;
      readonly eval: EvalCoverage;
      readonly compliance: ComplianceCoverage;
      readonly connector: ConnectorCoverage;
      readonly sme: SmeCoverage;
    };
    readonly recentScores?: readonly number[];
  }): Promise<DomainDepthSnapshot> {
    const targets = readTargets(args.catalogEntry);
    const score = computeCompositeScore(args.inputs, targets);
    const recentScoresWithCurrent = [score, ...(args.recentScores ?? [])];
    const recommendedTier = recommendTier({
      currentTier: args.catalogEntry.maturity,
      recentScores: recentScoresWithCurrent,
    });

    const now = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      await client.query(
        `INSERT INTO oweibo.domain_depth_snapshots
           (domain_slug, snapshot_at, composite_score, recommended_tier,
            ontology_coverage, eval_coverage, compliance_coverage,
            connector_coverage, sme_coverage)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
        [
          args.catalogEntry.slug,
          now,
          score,
          recommendedTier,
          JSON.stringify(args.coverages.ontology),
          JSON.stringify(args.coverages.eval),
          JSON.stringify(args.coverages.compliance),
          JSON.stringify(args.coverages.connector),
          JSON.stringify(args.coverages.sme),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    return {
      domainSlug: args.catalogEntry.slug,
      snapshotAt: now.toISOString(),
      compositeScore: score,
      recommendedTier,
      ontologyCoverage: args.coverages.ontology,
      evalCoverage: args.coverages.eval,
      complianceCoverage: args.coverages.compliance,
      connectorCoverage: args.coverages.connector,
      smeCoverage: args.coverages.sme,
    };
  }

  /**
   * F.4.5: return the most-recent snapshot for each known domain.
   * Used by the /domains/depth read endpoint. Implemented as a
   * DISTINCT ON over domain_slug.
   */
  async listLatestSnapshots(): Promise<readonly DomainDepthSnapshot[]> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<{
        domain_slug: string;
        snapshot_at: Date;
        composite_score: string | number;
        recommended_tier: string;
        ontology_coverage: OntologyCoverage;
        eval_coverage: EvalCoverage;
        compliance_coverage: ComplianceCoverage;
        connector_coverage: ConnectorCoverage;
        sme_coverage: SmeCoverage;
      }>(
        `SELECT DISTINCT ON (domain_slug)
                domain_slug, snapshot_at, composite_score, recommended_tier,
                ontology_coverage, eval_coverage, compliance_coverage,
                connector_coverage, sme_coverage
           FROM oweibo.domain_depth_snapshots
          ORDER BY domain_slug, snapshot_at DESC`,
      );
      return r.rows.map((row) => ({
        domainSlug: row.domain_slug,
        snapshotAt: row.snapshot_at.toISOString(),
        compositeScore: Number(row.composite_score),
        recommendedTier: row.recommended_tier as DomainDepthSnapshot['recommendedTier'],
        ontologyCoverage: row.ontology_coverage,
        evalCoverage: row.eval_coverage,
        complianceCoverage: row.compliance_coverage,
        connectorCoverage: row.connector_coverage,
        smeCoverage: row.sme_coverage,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Recent composite_score history (newest first) for a domain. Used
   * by the cron caller to supply `recentScores` to `writeSnapshot`.
   */
  async recentScores(domainSlug: DomainSlug, limit = 8): Promise<readonly number[]> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<{ composite_score: string | number }>(
        `SELECT composite_score FROM oweibo.domain_depth_snapshots
          WHERE domain_slug = $1
          ORDER BY snapshot_at DESC
          LIMIT $2`,
        [domainSlug, limit],
      );
      return r.rows.map((row) => Number(row.composite_score));
    } finally {
      client.release();
    }
  }

  /**
   * Persist a per-tenant utilization snapshot. utilization_ratio is
   * the caller's responsibility — typically `min((recall + rubric +
   * compliance) / expectedActivity, 1)` per the dashboard's narrative.
   */
  async writeTenantUtilization(snap: TenantDomainUtilizationSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      if (/^[0-9a-f-]{36}$/i.test(snap.tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${snap.tenantId}'`).catch(() => undefined);
      }
      await client.query(
        `INSERT INTO oweibo.tenant_domain_utilization
           (tenant_id, domain_slug, snapshot_at, ontology_recall_count,
            rubric_evaluation_count, compliance_evaluation_count,
            utilization_ratio)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [
          snap.tenantId,
          snap.domainSlug,
          new Date(snap.snapshotAt),
          snap.ontologyRecallCount,
          snap.rubricEvaluationCount,
          snap.complianceEvaluationCount,
          round3(clamp(snap.utilizationRatio, 0, 1)),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async setAdminScope(client: PoolClient): Promise<void> {
    await client.query(`SET LOCAL ROLE ${this.roleName()}`).catch(() => undefined);
    await client.query(`SET LOCAL app.is_platform_admin = 'true'`).catch(() => undefined);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

export function readTargets(entry: DomainCatalogEntry): DepthTargets {
  const t = entry.depthTargets ?? {};
  return {
    ontologyEntries: Number(t.ontologyEntries ?? 0),
    rubricCount: Number(t.rubricCount ?? 0),
    ruleCount: Number(t.ruleCount ?? 0),
    verifiedConnectors: Number(t.verifiedConnectors ?? 0),
    credentialedSmes: Number(t.credentialedSmes ?? 0),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
