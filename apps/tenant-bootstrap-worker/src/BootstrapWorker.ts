/**
 * T.1: BootstrapWorker — drives the per-tenant bootstrap step pipeline.
 *
 * Consumes `oweibo.lifecycle.tenant.created.v1` events from Redis (published by
 * OutboxRelay in T.0). For each event:
 *   1. Loads the tenant_bootstrap row (must exist; created by the platform
 *      handler in T.0).
 *   2. If state is 'ready' or 'disabled', no-op — idempotent.
 *   3. Otherwise transitions to 'running', then iterates STEP_PIPELINE.
 *   4. Each step writes a tenant_bootstrap_steps row; the orchestrator owns
 *      state transitions, retries, and dead-lettering.
 *   5. If all steps end ok|skipped → tenant_bootstrap.state='ready'.
 *      If any step exceeds maxAttemptsPerStep → state='failed' with last_error.
 *
 * Retry semantics: a step that returns 'failed' is re-executed on the next
 * lifecycle event for the same tenant, or by the periodic reconciliation
 * sweep. A step that throws is treated as 'failed'.
 */
import type { Pool, PoolClient } from 'pg';
import { withServiceSpan } from '@oweibo/observability';
import type {
  IBootstrapStep,
  IBootstrapStepContext,
  IBootstrapStepLogger,
  StepStatus,
} from './steps/IBootstrapStep.js';
import { SeedMemoriesStep } from './steps/SeedMemoriesStep.js';
import { SeedProjectStep } from './steps/SeedProjectStep.js';
import { SeedSkillsStep } from './steps/SeedSkillsStep.js';
import { SeedPriorsStep } from './steps/SeedPriorsStep.js';
import { SeedGoalTemplatesStep } from './steps/SeedGoalTemplatesStep.js';
import { SeedConnectorsStep } from './steps/SeedConnectorsStep.js';
import { DomainIntakeStep } from './steps/DomainIntakeStep.js';
import { InstallOntologyPackStep } from './steps/InstallOntologyPackStep.js';
import { SeedOrgGraphStep } from './steps/SeedOrgGraphStep.js';
import { CloneFromTenantStep } from './steps/CloneFromTenantStep.js';

export const STEP_PIPELINE: readonly IBootstrapStep[] = [
  // T.9: must run BEFORE SeedMemoriesStep so platform seeds layer on top of
  //      parent-cloned content (existing seed:<id> dedup in T.2.a handles
  //      overlap).
  new CloneFromTenantStep(),
  new SeedMemoriesStep(),
  new SeedProjectStep(),
  new SeedSkillsStep(),
  new SeedPriorsStep(),
  new SeedGoalTemplatesStep(),
  new SeedConnectorsStep(), // T.2.f
  new DomainIntakeStep(),   // T.2.g
  // D.1: runs AFTER DomainIntakeStep so the classified domain is
  // available to the installer; runs BEFORE SeedOrgGraphStep so the
  // org-graph step can read domain-archetype roles from the ontology
  // pack metadata (D.6 enhancement, byte-noop today).
  new InstallOntologyPackStep(),
  new SeedOrgGraphStep(),   // T.2.h
];

export interface BootstrapWorkerOptions {
  /** Max retries per step before marking the whole bootstrap 'failed'. */
  maxAttemptsPerStep?: number;
  logger?: IBootstrapStepLogger;
  /** For tests — override the step pipeline. */
  pipeline?: readonly IBootstrapStep[];
  /** T.8: platform-wide region_aware_intake flag. When true, the worker
   *  loads the tenant's home_region and threads it through the step ctx;
   *  steps consult ctx.homeRegion to filter region-tagged content. */
  regionAwareIntake?: boolean;
}

interface BootstrapRow {
  tenant_id: string;
  state: 'pending' | 'running' | 'ready' | 'failed' | 'disabled';
  template_slug: string;
  attempts: number;
  /** T.5.e: nullable so old rows without the column still parse correctly. */
  seed_cohort: 'seeded' | 'control' | 'exempt' | null;
}

interface StepRow {
  attempts: number;
  status: StepStatus | 'pending' | 'running';
  /** Audit-fix (T.1): nullable for backwards compat with rows predating the column. */
  skip_reason?: string | null;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export interface PipelineValidationReport {
  /** Step names that report `isWired() === true` (or omit isWired). */
  readonly wired: readonly string[];
  /** Step names that report `isWired() === false` — would silently no-op. */
  readonly unwired: readonly string[];
}

export class BootstrapWorker {
  private readonly maxAttempts: number;
  private readonly logger: IBootstrapStepLogger;
  private readonly pipeline: readonly IBootstrapStep[];
  private readonly regionAwareIntake: boolean;

  constructor(
    private readonly pool: Pool,
    private readonly features: (tenantId: string, tx: PoolClient) => Promise<Readonly<Record<string, unknown>>>,
    opts: BootstrapWorkerOptions = {},
  ) {
    this.maxAttempts = opts.maxAttemptsPerStep ?? DEFAULT_MAX_ATTEMPTS;
    this.logger = opts.logger ?? defaultLogger;
    this.pipeline = opts.pipeline ?? STEP_PIPELINE;
    this.regionAwareIntake = opts.regionAwareIntake ?? false;
  }

  /**
   * Audit-fix: introspect the pipeline and report which steps have
   * their adapters wired. Production entry points should call this at
   * startup and refuse to run if `unwired.length > 0` — otherwise
   * every tenant bootstrap silently no-ops with state='ready' and
   * zero content seeded.
   */
  validatePipeline(): PipelineValidationReport {
    const wired: string[] = [];
    const unwired: string[] = [];
    for (const step of this.pipeline) {
      // Steps that don't implement isWired() are assumed wired (they
      // have no adapter seam).
      if (step.isWired === undefined || step.isWired()) {
        wired.push(step.name);
      } else {
        unwired.push(step.name);
      }
    }
    return { wired, unwired };
  }

  /**
   * Drives a single tenant through the pipeline. Idempotent — safe to invoke
   * repeatedly for the same tenant id (steps that already returned 'ok' or
   * 'skipped' are not re-executed; failed steps retry up to maxAttempts).
   *
   * Audit-fix: the running-state transition is now an atomic CAS that
   * only fires when the row is in 'pending' or 'failed'. Two concurrent
   * invocations (e.g. multiple replicas receiving the same Redis pubsub
   * message, or a reconcile sweep racing the live event) end with one
   * worker doing the work and the other returning 'noop' — no
   * double-incremented attempts and no duplicate pipeline iteration.
   */
  async handleTenantCreated(tenantId: string): Promise<'ready' | 'failed' | 'noop'> {
    // F.7.1: per-tenant bootstrap span with final-state outcome attribute.
    return withServiceSpan({
      name: 'bootstrap.handle_tenant_created',
      attributes: { 'oweibo.tenant_id': tenantId },
    }, async (recordAttr) => {
      const result = await this.handleTenantCreatedInner(tenantId);
      recordAttr('oweibo.bootstrap.outcome', result);
      return result;
    });
  }

  private async handleTenantCreatedInner(tenantId: string): Promise<'ready' | 'failed' | 'noop'> {
    const bootstrap = await this.claimBootstrap(tenantId);
    if (!bootstrap) {
      // Either the row doesn't exist OR another worker already claimed it.
      // Both are no-ops from this caller's perspective.
      return 'noop';
    }

    const features = await this.loadFeatures(tenantId);
    // T.8: when the platform-wide flag is on, load tenant home_region so
    // region-tagged content can be filtered at install time. The lookup is
    // a single indexed read; failures degrade to undefined (= region-
    // agnostic, today's behaviour).
    const homeRegion = this.regionAwareIntake
      ? await this.loadHomeRegion(tenantId).catch(() => undefined)
      : undefined;

    let failed = false;
    let lastError: string | undefined;

    for (const step of this.pipeline) {
      const existing = await this.loadStep(tenantId, step.name);
      // Audit-fix (T.1): a step previously skipped with skip_reason
      // 'mode_too_low' is re-attempted on the reconciliation sweep so
      // a maturing tenant eventually picks up content seeding that was
      // gated off during cold-start. All other skip reasons remain
      // terminal.
      const reattemptableSkip =
        existing?.status === 'skipped' && existing?.skip_reason === 'mode_too_low';
      if (existing && existing.status === 'ok') continue;
      if (existing && existing.status === 'skipped' && !reattemptableSkip) continue;
      if (existing && existing.attempts >= this.maxAttempts) {
        failed = true;
        lastError = `step ${step.name} exceeded max attempts`;
        break;
      }

      await this.upsertStep(tenantId, step.name, 'running');
      const ctx: IBootstrapStepContext = {
        tenantId,
        templateSlug: bootstrap.template_slug,
        pool: this.pool,
        logger: this.logger,
        features,
        // T.5.e: cohort defaults to 'seeded' for rows that predate the column.
        seedCohort: bootstrap.seed_cohort ?? 'seeded',
        // T.8: only populated when the flag is on; undefined preserves
        // today's region-agnostic semantics at the step layer.
        ...(homeRegion !== undefined ? { homeRegion } : {}),
      };
      let status: StepStatus;
      let err: string | undefined;
      let skipReason: string | undefined;
      try {
        const result = await step.execute(ctx);
        // Audit-fix (T.1): accept either the bare StepStatus (legacy) or
        // a StepResult ({ status, skipReason?, message? }).
        if (typeof result === 'string') {
          status = result;
        } else {
          status = result.status;
          skipReason = result.skipReason;
          err = result.message;
        }
      } catch (e) {
        status = 'failed';
        err = e instanceof Error ? e.message : String(e);
        this.logger.error('BootstrapWorker: step threw', { tenantId, step: step.name, error: err });
      }
      await this.upsertStep(tenantId, step.name, status, err, skipReason);

      if (status === 'failed') {
        const updated = await this.loadStep(tenantId, step.name);
        if (updated && updated.attempts >= this.maxAttempts) {
          failed = true;
          lastError = err ?? `step ${step.name} failed`;
          break;
        }
        failed = true;
        lastError = err ?? `step ${step.name} returned failed (will retry)`;
        break;
      }
    }

    const finalState = failed ? 'failed' : 'ready';
    await this.transitionState(tenantId, finalState, { lastError, completed: finalState === 'ready' });
    return finalState;
  }

  // ── Persistence helpers ─────────────────────────────────────────────────

  /**
   * Atomically claim a tenant_bootstrap row by transitioning it from
   * 'pending' or 'failed' to 'running'. Returns the freshly-claimed row
   * shape so the caller can drive the pipeline. Returns null if:
   *   - the row doesn't exist (a stray event for a non-bootstrapped tenant)
   *   - the row is in 'ready' or 'disabled' (already done / opted-out)
   *   - the row is already 'running' (another worker has it)
   *
   * The single UPDATE-RETURNING means no other worker can observe the
   * pre-running state — perfect serialisation under PG read-committed.
   */
  private async claimBootstrap(tenantId: string): Promise<BootstrapRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, tenantId);
      const result = await client.query<BootstrapRow>(
        `UPDATE oweibo.tenant_bootstrap
            SET state        = 'running',
                attempts     = attempts + 1,
                started_at   = COALESCE(started_at, NOW()),
                updated_at   = NOW()
          WHERE tenant_id = $1::uuid
            AND state IN ('pending', 'failed')
          RETURNING tenant_id, state, template_slug, attempts, seed_cohort`,
        [tenantId],
      );
      await client.query('COMMIT');
      return result.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadHomeRegion(tenantId: string): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      const r = await client.query<{ home_region: string }>(
        `SELECT home_region FROM oweibo.tenants WHERE id = $1::uuid`,
        [tenantId],
      );
      return r.rows[0]?.home_region ?? undefined;
    } finally {
      client.release();
    }
  }

  private async loadStep(tenantId: string, stepName: string): Promise<StepRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, tenantId);
      const result = await client.query<StepRow>(
        `SELECT attempts, status, skip_reason
           FROM oweibo.tenant_bootstrap_steps
          WHERE tenant_id = $1::uuid AND step_name = $2`,
        [tenantId, stepName],
      );
      await client.query('COMMIT');
      return result.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertStep(
    tenantId: string,
    stepName: string,
    status: StepStatus | 'running',
    lastError?: string,
    skipReason?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, tenantId);
      const startedTouch = status === 'running' ? 'COALESCE(oweibo.tenant_bootstrap_steps.started_at, NOW())' : 'oweibo.tenant_bootstrap_steps.started_at';
      const completedTouch = status === 'ok' || status === 'skipped' || status === 'failed' ? 'NOW()' : 'NULL';
      await client.query(
        `INSERT INTO oweibo.tenant_bootstrap_steps (
           tenant_id, step_name, status, attempts, last_error, started_at, completed_at, skip_reason
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7, $8
         )
         ON CONFLICT (tenant_id, step_name) DO UPDATE
           SET status       = EXCLUDED.status,
               attempts     = oweibo.tenant_bootstrap_steps.attempts + CASE WHEN EXCLUDED.status = 'running' THEN 1 ELSE 0 END,
               last_error   = COALESCE(EXCLUDED.last_error, oweibo.tenant_bootstrap_steps.last_error),
               -- Audit-fix (T.1): always overwrite skip_reason on
               -- skipped status (so a re-attempted step can clear or
               -- replace the prior reason); preserve existing value for
               -- non-skipped statuses.
               skip_reason  = CASE WHEN EXCLUDED.status = 'skipped' THEN EXCLUDED.skip_reason
                                   ELSE oweibo.tenant_bootstrap_steps.skip_reason END,
               started_at   = ${startedTouch},
               completed_at = ${completedTouch === 'NULL' ? 'oweibo.tenant_bootstrap_steps.completed_at' : completedTouch}`,
        [
          tenantId,
          stepName,
          status,
          status === 'running' ? 1 : 0,
          lastError ?? null,
          status === 'running' ? new Date() : null,
          status === 'ok' || status === 'skipped' || status === 'failed' ? new Date() : null,
          skipReason ?? null,
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

  private async transitionState(
    tenantId: string,
    state: BootstrapRow['state'],
    opts: { incrementAttempts?: boolean; lastError?: string; completed?: boolean } = {},
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, tenantId);
      const setStarted = state === 'running';
      const setCompleted = opts.completed === true;
      await client.query(
        `UPDATE oweibo.tenant_bootstrap
            SET state        = $2,
                attempts     = attempts + ${opts.incrementAttempts ? 1 : 0},
                last_error   = COALESCE($3, last_error),
                started_at   = ${setStarted ? 'COALESCE(started_at, NOW())' : 'started_at'},
                completed_at = ${setCompleted ? 'NOW()' : 'completed_at'},
                updated_at   = NOW()
          WHERE tenant_id = $1::uuid`,
        [tenantId, state, opts.lastError ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadFeatures(tenantId: string): Promise<Readonly<Record<string, unknown>>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, tenantId);
      const out = await this.features(tenantId, client);
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

async function setScope(client: PoolClient, tenantId: string): Promise<void> {
  if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  }
  // The bootstrap worker reads platform-curated tenant rows; running as
  // platform_admin avoids per-tenant RLS friction. This service is internal,
  // not user-facing.
  await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
}

const defaultLogger: IBootstrapStepLogger = {
  info:  (message, extra) => console.log(`[BootstrapWorker] ${message}`, extra ?? {}),
  warn:  (message, extra) => console.warn(`[BootstrapWorker] ${message}`, extra ?? {}),
  error: (message, extra) => console.error(`[BootstrapWorker] ${message}`, extra ?? {}),
};

/** Default features loader: reads tenants.features JSONB for the given tenant. */
export async function defaultFeaturesLoader(tenantId: string, client: PoolClient): Promise<Readonly<Record<string, unknown>>> {
  const result = await client.query<{ features: Record<string, unknown> | null }>(
    `SELECT features FROM oweibo.tenants WHERE id = $1::uuid`,
    [tenantId],
  );
  return result.rows[0]?.features ?? {};
}
