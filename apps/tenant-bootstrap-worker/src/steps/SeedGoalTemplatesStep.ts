/**
 * T.1 no-op stub. T.2.d installs the curated goal-template library so
 * GoalDecomposer can match incoming goals against starter templates before
 * falling back to LLM decomposition from raw text.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export class SeedGoalTemplatesStep implements IBootstrapStep {
  readonly name = 'seed_goal_templates';
  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_goal_templates.enabled')) return 'skipped';
    return 'skipped';
  }
}
