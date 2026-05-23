/**
 * T.9: CloneFromTenantStep — for child tenants created with a parent
 * lineage, this step copies the opt-in scope set from the parent.
 *
 * Runs *before* SeedMemoriesStep so parent-derived content arrives first
 * and platform seeds layer on top using the existing dedup rules in T.2.a
 * (seed:<id> tag idempotency).
 *
 * Architecture (mirrors SeedMemoriesStep):
 *   - The worker process does NOT depend on Qdrant / embeddings / Redis.
 *   - The step accepts an `ITenantCloner` interface; a real cloner is
 *     wired by operators once the platform-side endpoints exist. Default
 *     is no-op → step returns 'skipped'. Byte-identical-to-today for
 *     tenants without lineage.
 *
 * Reading the lineage row uses the tenant's own scope (RLS allows the
 * child to read its own row via `child_can_read` policy).
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export type CloneScope =
  | 'memories'
  | 'projects'
  | 'org_graph'
  | 'connectors_recommend'
  | 'settings';

export interface CloneScopeResult {
  readonly scope: CloneScope;
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly copied?: number;
  readonly error?: string;
}

export interface ITenantCloner {
  /**
   * Clone the requested scopes from parent → child. Implementations must
   * never throw; failures are reported per-scope so a single-scope failure
   * doesn't fail the entire bootstrap.
   */
  clone(req: {
    readonly parentTenantId: string;
    readonly childTenantId: string;
    readonly scopes: readonly CloneScope[];
  }): Promise<{ readonly results: readonly CloneScopeResult[] }>;
}

interface LineageRow {
  readonly parent_tenant_id: string;
  readonly cloned_scopes: readonly string[];
}

export interface CloneFromTenantStepOptions {
  /** Concrete cloner; default no-op skips the step. */
  cloner?: ITenantCloner;
}

export class CloneFromTenantStep implements IBootstrapStep {
  readonly name = 'clone_from_tenant';

  constructor(private readonly opts: CloneFromTenantStepOptions = {}) {}

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant_lineage.enabled')) {
      return 'skipped';
    }
    const lineage = await this.loadLineage(ctx);
    if (!lineage) {
      // Regular (non-lineage) tenant — nothing to clone.
      return 'skipped';
    }
    const scopes = lineage.cloned_scopes.filter(isCloneScope);
    if (scopes.length === 0) {
      ctx.logger.info('CloneFromTenantStep: lineage row carries no recognised scopes', {
        tenantId: ctx.tenantId,
        parentTenantId: lineage.parent_tenant_id,
      });
      return 'skipped';
    }
    if (!this.opts.cloner) {
      ctx.logger.info('CloneFromTenantStep: cloner not wired; lineage row present but skipping', {
        tenantId: ctx.tenantId,
        parentTenantId: lineage.parent_tenant_id,
        scopes,
      });
      return 'skipped';
    }

    let summary;
    try {
      summary = await this.opts.cloner.clone({
        parentTenantId: lineage.parent_tenant_id,
        childTenantId: ctx.tenantId,
        scopes,
      });
    } catch (err) {
      ctx.logger.error('CloneFromTenantStep: cloner threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    const failed = summary.results.filter((r) => r.status === 'failed');
    const ok = summary.results.filter((r) => r.status === 'ok');
    ctx.logger.info('CloneFromTenantStep: clone summary', {
      tenantId: ctx.tenantId,
      parentTenantId: lineage.parent_tenant_id,
      okCount: ok.length,
      failedCount: failed.length,
      skippedCount: summary.results.length - ok.length - failed.length,
    });
    // Per-scope failures don't fail the whole step (operator can re-run
    // individual scopes via CLI). Only fail when *every* requested scope
    // failed — that's a wiring problem, not a content problem.
    if (failed.length > 0 && ok.length === 0) {
      return 'failed';
    }
    return 'ok';
  }

  private async loadLineage(ctx: IBootstrapStepContext): Promise<LineageRow | null> {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      // The lineage table is RLS-keyed off current_setting('app.tenant_id').
      // Set the scope so the child tenant's own row is visible.
      await client.query(`SET LOCAL app.tenant_id = $1`, [ctx.tenantId]);
      const r = await client.query<LineageRow>(
        `SELECT parent_tenant_id, cloned_scopes
           FROM oweibo.tenant_lineage
          WHERE child_tenant_id = $1::uuid`,
        [ctx.tenantId],
      );
      await client.query('COMMIT');
      return r.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      ctx.logger.error('CloneFromTenantStep: lineage lookup failed', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      client.release();
    }
  }
}

function isCloneScope(s: string): s is CloneScope {
  return s === 'memories' || s === 'projects' || s === 'org_graph'
    || s === 'connectors_recommend' || s === 'settings';
}
