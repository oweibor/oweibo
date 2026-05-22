/**
 * T.2.d: SeedGoalTemplatesStep — records the tenant's acknowledgement that
 * the platform goal-template catalog applies to its first task. Unlike
 * SeedMemoriesStep / SeedSkillsStep this step does NOT write per-tenant
 * data — the catalog is cross-tenant (oweibo.goal_templates, read-only to
 * tenants). The step exists so the bootstrap state machine has a hook
 * point to count toward "ready", and so future versions can copy in a
 * tenant-specific override layer.
 *
 * Like the rest of T.2.* steps, the step accepts an injectable
 * IGoalTemplateAcknowledger. The default (no acknowledger wired) returns
 * 'skipped', preserving the T.1 stub semantics.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface GoalTemplateAckResult {
  /** How many templates would apply for this tenant given its template + industry. */
  readonly applicableCount: number;
  /** The catalog version observed at ack time. */
  readonly catalogVersion: string;
}

export interface IGoalTemplateAcknowledger {
  acknowledge(tenantId: string, templateSlug: string, industry?: string): Promise<GoalTemplateAckResult>;
}

export interface SeedGoalTemplatesStepOptions {
  acknowledger?: IGoalTemplateAcknowledger;
}

export class SeedGoalTemplatesStep implements IBootstrapStep {
  readonly name = 'seed_goal_templates';

  constructor(private readonly opts: SeedGoalTemplatesStepOptions = {}) {}

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_goal_templates.enabled')) {
      return 'skipped';
    }
    if (!this.opts.acknowledger) {
      ctx.logger.info('SeedGoalTemplatesStep: acknowledger not wired; skipping', {
        tenantId: ctx.tenantId,
      });
      return 'skipped';
    }

    const industry = typeof ctx.features['industry'] === 'string'
      ? (ctx.features['industry'] as string)
      : undefined;

    let result: GoalTemplateAckResult;
    try {
      result = await this.opts.acknowledger.acknowledge(ctx.tenantId, ctx.templateSlug, industry);
    } catch (err) {
      ctx.logger.error('SeedGoalTemplatesStep: acknowledger threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedGoalTemplatesStep: catalog acknowledged', {
      tenantId: ctx.tenantId,
      applicableCount: result.applicableCount,
      catalogVersion: result.catalogVersion,
    });

    return 'ok';
  }
}
