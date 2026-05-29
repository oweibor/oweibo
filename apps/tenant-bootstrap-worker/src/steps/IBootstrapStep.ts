/**
 * T.1: IBootstrapStep — contract every bootstrap pipeline step implements.
 *
 * Steps are pure executions: given a context (tenant id, template, pool, logger)
 * they perform their side effect and return a terminal status. The orchestrator
 * (BootstrapWorker) handles state transitions, retries, and dead-lettering.
 */
import type { Pool } from 'pg';

export interface IBootstrapStepLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface IBootstrapStepContext {
  readonly tenantId: string;
  readonly templateSlug: string;
  readonly pool: Pool;
  readonly logger: IBootstrapStepLogger;
  /** Per-tenant features JSONB; steps read their own feature flag from here. */
  readonly features: Readonly<Record<string, unknown>>;
  /** T.5.e: seed-cohort label assigned at tenant-create time. Steps that
   *  participate in the A/B trial (SeedMemoriesStep) read this to decide
   *  whether to execute. Defaults to 'seeded' for tenants created before T.5.e. */
  readonly seedCohort: 'seeded' | 'control' | 'exempt';
  /** T.8: tenant home_region (e.g. `us-east-1`). Only populated when the
   *  platform-wide region_aware_intake flag is enabled; otherwise undefined
   *  so consumers can fall through to the byte-identical-to-today behaviour. */
  readonly homeRegion?: string;
}

/** Terminal status returned by a step. */
export type StepStatus = 'ok' | 'skipped' | 'failed';

/**
 * Audit-fix (T.1): structured reasons a step can record alongside
 * `skipped` so the reconciliation sweep distinguishes "skipped because
 * mode-too-low (re-attempt when tenant matures)" from "skipped because
 * feature flag off (do not re-attempt)" without fragile string-matching
 * on `last_error`.
 *
 * `mode_too_low` is the only re-attemptable skip — the reconciler will
 * retry these steps when the tenant's bootstrap-state matures. All
 * other skip reasons are terminal.
 */
export type StepSkipReason =
  | 'mode_too_low'
  | 'feature_flag_off'
  | 'precondition_not_met'
  | 'optional_step'
  | 'no_content';

export interface StepResult {
  readonly status: StepStatus;
  /** Required when status === 'skipped'; populated to skip_reason. */
  readonly skipReason?: StepSkipReason;
  /** Optional free-text; persisted to last_error. */
  readonly message?: string;
}

export interface IBootstrapStep {
  readonly name: string;
  /**
   * Returns 'ok' on success, 'skipped' if a precondition is unmet (feature flag
   * off, no content to seed, mode-too-low, …), 'failed' to request a retry, or
   * throws to dead-letter immediately after the worker's retry budget elapses.
   *
   * Steps MAY return a `StepResult` to populate the audit-fix structured
   * skip_reason column. Returning a bare `StepStatus` remains valid for
   * backwards compatibility; the worker treats those as "skip_reason
   * unknown" which the reconciler will not re-attempt.
   */
  execute(ctx: IBootstrapStepContext): Promise<StepStatus | StepResult>;
  /**
   * Audit-fix: optional self-check that returns true when the step has
   * its required adapters (writer/seeder/cloner/etc.) injected and will
   * be able to do real work, vs. silently returning 'skipped' on every
   * call. BootstrapWorker.validatePipeline() uses this to refuse a
   * production start with no adapters wired.
   *
   * Steps without any optional adapters return true unconditionally
   * (they have nothing to wire). Steps with optional adapter seams
   * return false until those adapters are injected.
   */
  isWired?(): boolean;
}
