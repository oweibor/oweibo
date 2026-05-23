/**
 * T.3.b: SeedPriorsStep — pre-seeds per-tenant bandit arms with the
 * platform-aggregated priors (from T.3.a) for a known set of slot/channel
 * pairs. This is *optional* — when bandit.use_platform_priors is off or
 * the aggregator has produced no rows yet, the step skips and the legacy
 * Beta(1,1) path is preserved.
 *
 * Architecture mirrors the rest of the T.2.x / T.3.x steps: accepts an
 * injectable IPriorsSeeder so the worker process need not import
 * BanditService.
 *
 * Mode-aware: in production this step is the only one that is gated on
 * OperationalMode >= 5 (bandit learning). The injected seeder is expected
 * to enforce that gate; if the seeder returns 'mode_too_low' the step
 * reports 'skipped' rather than 'failed' so the periodic reconciliation
 * sweep re-attempts at mode promotion (per ttv.md T.0 mode-0 matrix).
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export type PriorsSeedReason = 'ok' | 'no_priors_available' | 'mode_too_low' | 'failed';

export interface PriorsSeedResult {
  readonly reason: PriorsSeedReason;
  readonly armsSeeded: number;
  readonly slotsConsidered: number;
}

export interface IPriorsSeeder {
  seedPriors(tenantId: string): Promise<PriorsSeedResult>;
}

export interface SeedPriorsStepOptions {
  seeder?: IPriorsSeeder;
}

export class SeedPriorsStep implements IBootstrapStep {
  readonly name = 'seed_priors';

  constructor(private readonly opts: SeedPriorsStepOptions = {}) {}

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_priors.enabled')) {
      return 'skipped';
    }
    if (!this.opts.seeder) {
      ctx.logger.info('SeedPriorsStep: seeder not wired; skipping', { tenantId: ctx.tenantId });
      return 'skipped';
    }

    let result: PriorsSeedResult;
    try {
      result = await this.opts.seeder.seedPriors(ctx.tenantId);
    } catch (err) {
      ctx.logger.error('SeedPriorsStep: seeder threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedPriorsStep: priors evaluated', {
      tenantId: ctx.tenantId,
      reason: result.reason,
      armsSeeded: result.armsSeeded,
      slotsConsidered: result.slotsConsidered,
    });

    switch (result.reason) {
      case 'ok':
      case 'no_priors_available':
        return 'ok';
      case 'mode_too_low':
        // Re-attempt at mode promotion via the periodic reconciliation
        // sweep. 'skipped' is the right disposition — not a failure.
        return 'skipped';
      case 'failed':
        return 'failed';
    }
  }
}
