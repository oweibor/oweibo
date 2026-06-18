/**
 * T.2.g — DomainIntakeStep tests.
 */
import type { Pool } from 'pg';
import {
  DomainIntakeStep,
  type IDomainIntakeProcessor,
} from '../steps/DomainIntakeStep.js';
import type { IBootstrapStepContext } from '../steps/IBootstrapStep.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
function ctx(overrides: Partial<IBootstrapStepContext> = {}): IBootstrapStepContext {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    templateSlug: 'default',
    pool: {} as Pool,
    logger: silent,
    features: overrides.features ?? {},
    seedCohort: 'seeded',
    ...overrides,
  } as IBootstrapStepContext;
}

function processor(opts: Partial<IDomainIntakeProcessor> = {}): IDomainIntakeProcessor {
  return {
    loadState: opts.loadState ?? jest.fn().mockResolvedValue('absent'),
    process: opts.process ?? jest.fn(),
  };
}

describe('DomainIntakeStep', () => {
  it('skips when feature flag is off', async () => {
    const p = processor();
    const step = new DomainIntakeStep({ processor: p });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(p.loadState).not.toHaveBeenCalled();
  });

  it('skips when processor is not wired', async () => {
    const step = new DomainIntakeStep();
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.domain_intake.enabled': true } }))).toBe('skipped');
  });

  it('skips when state is pending / absent / skipped / complete', async () => {
    for (const state of ['absent', 'pending', 'skipped', 'complete'] as const) {
      const p = processor({ loadState: jest.fn().mockResolvedValue(state) });
      const step = new DomainIntakeStep({ processor: p });
      const result = await step.execute(ctx({ features: { 'tenant.bootstrap.domain_intake.enabled': true } }));
      expect(result).toBe('skipped');
      expect(p.process).not.toHaveBeenCalled();
    }
  });

  it("returns 'failed' when previous attempt left state='failed'", async () => {
    const p = processor({ loadState: jest.fn().mockResolvedValue('failed') });
    const step = new DomainIntakeStep({ processor: p });
    const result = await step.execute(ctx({ features: { 'tenant.bootstrap.domain_intake.enabled': true } }));
    expect(result).toBe('failed');
    expect(p.process).not.toHaveBeenCalled();
  });

  it("processes when state='requested' and returns 'ok'", async () => {
    const p = processor({
      loadState: jest.fn().mockResolvedValue('requested'),
      process: jest.fn().mockResolvedValue({
        classifiedDomain: 'finance',
        classifiedConfidence: 0.91,
        recommendedTemplate: 'fintech-smb',
        recommendedConnectors: ['stripe'],
        recommendedSeedSkills: ['code-review-pass'],
      }),
    });
    const step = new DomainIntakeStep({ processor: p });
    const result = await step.execute(ctx({ features: { 'tenant.bootstrap.domain_intake.enabled': true } }));
    expect(result).toBe('ok');
    expect(p.process).toHaveBeenCalled();
  });

  it("returns 'failed' when processor throws", async () => {
    const p = processor({
      loadState: jest.fn().mockResolvedValue('requested'),
      process: jest.fn().mockRejectedValue(new Error('classifier down')),
    });
    const step = new DomainIntakeStep({ processor: p });
    const result = await step.execute(ctx({ features: { 'tenant.bootstrap.domain_intake.enabled': true } }));
    expect(result).toBe('failed');
  });

  it('lets loadState errors propagate so BootstrapWorker records failed + retries', async () => {
    const p = processor({
      loadState: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const step = new DomainIntakeStep({ processor: p });
    await expect(
      step.execute(ctx({ features: { 'tenant.bootstrap.domain_intake.enabled': true } })),
    ).rejects.toThrow(/db down/);
  });
});
