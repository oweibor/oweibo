/**
 * T.1 no-op stub. T.2.b creates a starter project so the project-channel of
 * MemoryWarmer is non-empty for the tenant's first task.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export class SeedProjectStep implements IBootstrapStep {
  readonly name = 'seed_project';
  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_project.enabled')) return 'skipped';
    return 'skipped';
  }
}
