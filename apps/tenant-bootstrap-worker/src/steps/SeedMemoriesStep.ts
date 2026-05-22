/**
 * T.1 no-op stub. T.2.a will replace this with the platform seed-memory loader
 * that writes curated seed entries to the tenant's Qdrant collection.
 *
 * Skip rationale: feature flag `tenant.bootstrap.seed_memories.enabled` is
 * false until T.2.a ships. Always returns 'skipped' in this phase.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export class SeedMemoriesStep implements IBootstrapStep {
  readonly name = 'seed_memories';
  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_memories.enabled')) return 'skipped';
    return 'skipped';
  }
}
