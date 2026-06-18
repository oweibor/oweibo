/**
 * T.2.d — SeedGoalTemplatesStep unit tests.
 */
import type { Pool } from 'pg';
import {
  SeedGoalTemplatesStep,
  type IGoalTemplateAcknowledger,
} from '../steps/SeedGoalTemplatesStep.js';
import type { IBootstrapStepContext } from '../steps/IBootstrapStep.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
function ctx(overrides: Partial<IBootstrapStepContext> = {}): IBootstrapStepContext {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    templateSlug: 'default',
    pool: {} as Pool,
    logger: silent,
    features: overrides.features ?? {},
    ...overrides,
  } as IBootstrapStepContext;
}

describe('SeedGoalTemplatesStep', () => {
  it('skips when feature flag is off', async () => {
    const ack: IGoalTemplateAcknowledger = { acknowledge: jest.fn() };
    const step = new SeedGoalTemplatesStep({ acknowledger: ack });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(ack.acknowledge).not.toHaveBeenCalled();
  });

  it('skips when acknowledger is not wired', async () => {
    const step = new SeedGoalTemplatesStep();
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_goal_templates.enabled': true } }))).toBe('skipped');
  });

  it("returns 'ok' on a successful ack", async () => {
    const ack: IGoalTemplateAcknowledger = {
      acknowledge: jest.fn().mockResolvedValue({ applicableCount: 3, catalogVersion: '1' }),
    };
    const step = new SeedGoalTemplatesStep({ acknowledger: ack });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_goal_templates.enabled': true } }))).toBe('ok');
    expect(ack.acknowledge).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'default',
      undefined,
    );
  });

  it('passes industry through when present', async () => {
    const ack: IGoalTemplateAcknowledger = {
      acknowledge: jest.fn().mockResolvedValue({ applicableCount: 1, catalogVersion: '1' }),
    };
    const step = new SeedGoalTemplatesStep({ acknowledger: ack });
    await step.execute(ctx({
      templateSlug: 'fintech-starter',
      features: { 'tenant.bootstrap.seed_goal_templates.enabled': true, industry: 'fintech' },
    }));
    expect(ack.acknowledge).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'fintech-starter',
      'fintech',
    );
  });

  it("returns 'failed' when acknowledger throws", async () => {
    const ack: IGoalTemplateAcknowledger = {
      acknowledge: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new SeedGoalTemplatesStep({ acknowledger: ack });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_goal_templates.enabled': true } }))).toBe('failed');
  });
});
