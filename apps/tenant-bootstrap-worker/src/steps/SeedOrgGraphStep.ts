/**
 * T.2.h: SeedOrgGraphStep — installs the minimal day-one org graph.
 *
 * Architecture mirrors the rest of T.2.*: accepts an injectable
 * IOrgGraphSeeder so the worker process does not have to instantiate the
 * full OrgGraphService (which lives in core-engine and needs a pg Pool).
 * The default (no seeder wired) returns 'skipped' — matches the T.1 stub
 * behavior for tenants that opt out via feature flag.
 *
 * Idempotency: implementations are expected to short-circuit when the
 * tenant already has a seeded graph (e.g. on bootstrap retry). The step
 * itself does no per-tenant state checking; that's the seeder's job.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface OrgGraphSeedResult {
  readonly creatorNodeId: string | null;
  readonly adminTeamNodeId: string | null;
  readonly councilNodeId: string | null;
  readonly nodesCreated: number;
  readonly edgesCreated: number;
}

export interface IOrgGraphSeeder {
  seed(tenantId: string): Promise<OrgGraphSeedResult>;
}

export interface SeedOrgGraphStepOptions {
  seeder?: IOrgGraphSeeder;
}

export class SeedOrgGraphStep implements IBootstrapStep {
  readonly name = 'seed_org_graph';

  constructor(private readonly opts: SeedOrgGraphStepOptions = {}) {}

  isWired(): boolean {
    return Boolean(this.opts.seeder);
  }

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.org_graph.enabled')) {
      return 'skipped';
    }
    if (!this.opts.seeder) {
      ctx.logger.info('SeedOrgGraphStep: seeder not wired; skipping', {
        tenantId: ctx.tenantId,
      });
      return 'skipped';
    }

    let result: OrgGraphSeedResult;
    try {
      result = await this.opts.seeder.seed(ctx.tenantId);
    } catch (err) {
      ctx.logger.error('SeedOrgGraphStep: seeder threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedOrgGraphStep: org graph seeded', {
      tenantId: ctx.tenantId,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      councilNodeId: result.councilNodeId,
    });
    return 'ok';
  }
}
