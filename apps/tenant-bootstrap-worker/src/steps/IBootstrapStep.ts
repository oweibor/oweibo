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
}

/** Terminal status returned by a step. */
export type StepStatus = 'ok' | 'skipped' | 'failed';

export interface IBootstrapStep {
  readonly name: string;
  /**
   * Returns 'ok' on success, 'skipped' if a precondition is unmet (feature flag
   * off, no content to seed, mode-too-low, …), 'failed' to request a retry, or
   * throws to dead-letter immediately after the worker's retry budget elapses.
   */
  execute(ctx: IBootstrapStepContext): Promise<StepStatus>;
}
