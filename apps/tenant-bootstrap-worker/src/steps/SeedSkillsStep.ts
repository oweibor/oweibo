/**
 * T.1 no-op stub. T.2.c writes a baseline SKILL.md bundle to the tenant's
 * workspace so the SkillRegistry has something to discover from day one.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export class SeedSkillsStep implements IBootstrapStep {
  readonly name = 'seed_skills';
  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_skills.enabled')) return 'skipped';
    return 'skipped';
  }
}
