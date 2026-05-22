/**
 * T.1 no-op stub. T.3.b seeds the bandit prior arms from the platform
 * aggregator's per-cohort priors. Mode-aware in production: skips when
 * OperationalMode < 5 (mode-too-low) and is re-attempted by the periodic
 * reconciliation sweep.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export class SeedPriorsStep implements IBootstrapStep {
  readonly name = 'seed_priors';
  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_priors.enabled')) return 'skipped';
    return 'skipped';
  }
}
