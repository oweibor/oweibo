/**
 * T.2.f: SeedConnectorsStep — surfaces the recommended connector set for the
 * tenant's template. Does NOT install anything automatically — installation
 * requires credentials only the operator can supply.
 *
 * Output: writes the list of recommended connector ids to
 * tenant_bootstrap_steps.result so the admin UI can render the
 * recommendation list at onboarding time.
 *
 * Like every other T.2.* step, accepts an injectable IConnectorRecommender
 * so the worker process does not have to import the full ConnectorRegistry
 * (which depends on @oweibo/core-engine). The default (no recommender
 * wired) returns 'skipped', matching the T.1 stub semantics.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface ConnectorRecommendation {
  readonly connectorId: string;
  readonly displayName: string;
}

export interface IConnectorRecommender {
  /**
   * Return the set of connectors recommended for the tenant given its
   * template + industry context. Implementations consult the catalog
   * (ConnectorRegistry.recommend) and may filter further.
   */
  recommend(tenantId: string, templateSlug: string, industry?: string): Promise<ConnectorRecommendation[]>;
}

export interface SeedConnectorsStepOptions {
  recommender?: IConnectorRecommender;
}

export class SeedConnectorsStep implements IBootstrapStep {
  readonly name = 'seed_connectors';

  constructor(private readonly opts: SeedConnectorsStepOptions = {}) {}

  isWired(): boolean {
    return Boolean(this.opts.recommender);
  }

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_connectors.enabled')) {
      return 'skipped';
    }
    if (!this.opts.recommender) {
      ctx.logger.info('SeedConnectorsStep: recommender not wired; skipping', {
        tenantId: ctx.tenantId,
      });
      return 'skipped';
    }

    const industry = typeof ctx.features['industry'] === 'string'
      ? (ctx.features['industry'] as string)
      : undefined;

    let recommendations: ConnectorRecommendation[];
    try {
      recommendations = await this.opts.recommender.recommend(ctx.tenantId, ctx.templateSlug, industry);
    } catch (err) {
      ctx.logger.error('SeedConnectorsStep: recommender threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedConnectorsStep: recommendations computed', {
      tenantId: ctx.tenantId,
      count: recommendations.length,
      ids: recommendations.map((r) => r.connectorId),
    });

    // Idempotency: re-running with the same recommender output is a no-op
    // from the orchestrator's perspective (BootstrapWorker skips 'ok' steps
    // on re-run). The recommendations themselves do not write per-tenant
    // rows — operators consume them via the admin UI.
    return 'ok';
  }
}
