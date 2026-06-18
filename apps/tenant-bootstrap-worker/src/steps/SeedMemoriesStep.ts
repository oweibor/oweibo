/**
 * T.2.a: SeedMemoriesStep — installs platform-curated seed memories into a
 * tenant's collection at bootstrap time.
 *
 * Architecture: the worker process does not import the heavy memory
 * orchestrator (Qdrant client, embeddings, Redis). Instead it accepts an
 * `ISeedMemoryWriter` injected at construction. The default writer is a
 * no-op that returns 'skipped' — preserves the byte-identical-to-today
 * behaviour when nothing is wired. Operators wire a real writer (HTTP
 * client to core-engine, or a direct orchestrator if the worker is run
 * in-process) once the platform memory API endpoint ships.
 *
 * Idempotency: the writer is told which seed ids the catalog wants to
 * install; the writer reports back which were inserted and which were
 * already present. Re-runs converge on a stable count.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface SeedMemoryRequest {
  readonly seedId: string;
  readonly catalogVersion: string;
  readonly kind: string;
  readonly summary: string;
  readonly body?: string;
  readonly importance: number;
  readonly tags: readonly string[];
}

export interface SeedMemoryWriteResult {
  readonly inserted: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}

export interface ISeedMemoryWriter {
  /**
   * Install the requested seeds into the tenant's collection. Implementations
   * must:
   *   1. Filter out seeds whose `seedId` already exists for the tenant (by tag
   *      `seed:<seedId>`).
   *   2. Write the remaining seeds with tag set including `seed:<seedId>` and
   *      `seed:catalog:<catalogVersion>` so the decay/consolidator/warmer
   *      filters can find them.
   *   3. Return the split — never throw on per-seed errors; collect them in
   *      `failed` so the step result captures the diagnostic.
   */
  writeSeeds(tenantId: string, seeds: readonly SeedMemoryRequest[]): Promise<SeedMemoryWriteResult>;
}

/** Catalog loader signature. Tests pass an in-memory catalog. */
export interface ISeedCatalogProvider {
  forTenant(filter: { templateSlug: string; industry?: string; homeRegion?: string }): SeedMemoryRequest[];
}

export interface SeedMemoriesStepOptions {
  writer?: ISeedMemoryWriter;
  catalog?: ISeedCatalogProvider;
}

export class SeedMemoriesStep implements IBootstrapStep {
  readonly name = 'seed_memories';

  constructor(private readonly opts: SeedMemoriesStepOptions = {}) {}

  isWired(): boolean {
    return Boolean(this.opts.writer && this.opts.catalog);
  }

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_memories.enabled')) {
      return 'skipped';
    }
    // T.5.e: control-arm tenants explicitly bypass the seed install so the
    // A/B trial measures the seed-install delta. The cohort label is set
    // at tenant-create time by SeedCohortAssigner; reading it here keeps
    // the step idempotent (same cohort → same outcome on every re-run).
    if (ctx.seedCohort === 'control') {
      ctx.logger.info('SeedMemoriesStep: skipping for A/B control cohort', {
        tenantId: ctx.tenantId,
      });
      return 'skipped';
    }
    if (!this.opts.writer || !this.opts.catalog) {
      // No writer / catalog wired — equivalent to the T.1 stub. Logged so
      // operators can tell the difference between "flag off" and "writer
      // missing".
      ctx.logger.info('SeedMemoriesStep: writer or catalog not wired; skipping', {
        tenantId: ctx.tenantId,
        hasWriter: Boolean(this.opts.writer),
        hasCatalog: Boolean(this.opts.catalog),
      });
      return 'skipped';
    }

    const industry = typeof ctx.features['industry'] === 'string'
      ? (ctx.features['industry'] as string)
      : undefined;
    const seeds = this.opts.catalog.forTenant({
      templateSlug: ctx.templateSlug,
      ...(industry ? { industry } : {}),
      // T.8: forward tenant home_region so region-tagged seeds filter
      // correctly. ctx.homeRegion is undefined unless the worker-level
      // region_aware_intake flag is on.
      ...(ctx.homeRegion !== undefined ? { homeRegion: ctx.homeRegion } : {}),
    });
    if (seeds.length === 0) {
      ctx.logger.info('SeedMemoriesStep: catalog returned no entries for this tenant', {
        tenantId: ctx.tenantId,
        templateSlug: ctx.templateSlug,
      });
      return 'skipped';
    }

    let result: SeedMemoryWriteResult;
    try {
      result = await this.opts.writer.writeSeeds(ctx.tenantId, seeds);
    } catch (err) {
      ctx.logger.error('SeedMemoriesStep: writer threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedMemoriesStep: catalog applied', {
      tenantId: ctx.tenantId,
      inserted: result.inserted.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    });

    if (result.failed.length > 0 && result.inserted.length === 0 && result.skipped.length === 0) {
      return 'failed';
    }
    return 'ok';
  }
}
