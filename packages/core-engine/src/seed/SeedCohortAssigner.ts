/**
 * T.5.e: SeedCohortAssigner — deterministic per-tenant A/B cohort assignment
 * for the seed-memory rollout trial.
 *
 * The platform team needs empirical evidence that the T.2.a seed install
 * actually shortens TTV. Without a control arm, we are investing engineering
 * effort in seeds without proof. This assigner produces:
 *   - 'seeded'  : tenant receives the full T.2.a seed install (default)
 *   - 'control' : tenant skips SeedMemoriesStep (cohort logged for analysis)
 *   - 'exempt'  : internal / synthetic tenants excluded from cohort stats
 *
 * Assignment is SHA256(tenantId) mod 2 — uniform across UUIDs, reproducible,
 * and unbiased by creation order. The feature flag SEED_AB_ENABLED gates the
 * cohorting: when off, every tenant lands in 'seeded' (matches today's
 * intended default).
 *
 * After the trial ends (~200 tenants or 90 days, whichever first), the
 * promotion criterion in ttv.md §T.5.e is evaluated by the analysis
 * subcommand. If positive, the assigner is left as-is. If negative, the
 * platform team revisits the seed catalog content.
 */
import { createHash } from 'crypto';

export type SeedCohort = 'seeded' | 'control' | 'exempt';

export interface SeedCohortAssignerOptions {
  /** When false, every tenant is assigned 'seeded' regardless of id.
   *  Default: env SEED_AB_ENABLED === 'true'. */
  isEnabled?: () => boolean;
  /** When the assigner sees a tenantId in this set, it returns 'exempt'.
   *  Used to keep internal / synthetic tenants out of cohort statistics. */
  exemptTenantIds?: ReadonlySet<string>;
}

export class SeedCohortAssigner {
  private readonly isEnabled: () => boolean;
  private readonly exempt: ReadonlySet<string>;

  constructor(opts: SeedCohortAssignerOptions = {}) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.exempt = opts.exemptTenantIds ?? new Set<string>();
  }

  /**
   * Deterministically assign a cohort to a tenant id. Same input always
   * yields the same output across processes — the assigner is safe to call
   * from any service (tenant-create handler, backfill script, analysis).
   */
  assign(tenantId: string): SeedCohort {
    return this.assignWithOverride(tenantId);
  }

  /**
   * Audit-fix (T.5.e): per-tenant override path. The tenant-create
   * handler accepts an optional `cohort_override` field (platform_admin
   * scope only); when present, the override wins outright. This is the
   * only way to mark a single tenant as 'exempt' without pre-seeding the
   * constructor-time `exemptTenantIds` set — important for tenants
   * created AFTER the worker boots (internal-test tenants created
   * mid-day, synthetic accounts created by load tests, etc.).
   *
   * Persistence: the override is stored on `tenant_bootstrap.seed_cohort`
   * at insert time; downstream readers (BootstrapWorker, the seed-A/B
   * analysis subcommand) consult that column directly, never re-running
   * the SHA256 cohorting for overridden tenants. This method documents
   * the override semantics for callers that re-derive the cohort.
   */
  assignWithOverride(tenantId: string, override?: SeedCohort): SeedCohort {
    if (override) return override;
    if (this.exempt.has(tenantId)) return 'exempt';
    if (!this.isEnabled()) return 'seeded';
    // SHA256 → first byte → bit 0 picks the cohort. SHA256 is uniform over
    // valid UUIDs so the parity of the first byte is fair.
    const digest = createHash('sha256').update(tenantId).digest();
    const bit = digest[0]! & 1;
    return bit === 0 ? 'seeded' : 'control';
  }
}

function defaultEnabled(): boolean {
  return process.env['SEED_AB_ENABLED'] === 'true';
}
