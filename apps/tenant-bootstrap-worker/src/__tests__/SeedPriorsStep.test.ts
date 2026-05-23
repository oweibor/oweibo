/**
 * T.3.b — SeedPriorsStep tests.
 */
import type { Pool } from 'pg';
import { SeedPriorsStep, type IPriorsSeeder } from '../steps/SeedPriorsStep.js';
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

describe('SeedPriorsStep', () => {
  it('skips when feature flag is off', async () => {
    const seeder: IPriorsSeeder = { seedPriors: jest.fn() };
    const step = new SeedPriorsStep({ seeder });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(seeder.seedPriors).not.toHaveBeenCalled();
  });

  it('skips when seeder is not wired', async () => {
    const step = new SeedPriorsStep();
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_priors.enabled': true } }))).toBe('skipped');
  });

  it("returns 'ok' when arms were seeded", async () => {
    const seeder: IPriorsSeeder = {
      seedPriors: jest.fn().mockResolvedValue({ reason: 'ok', armsSeeded: 4, slotsConsidered: 6 }),
    };
    const step = new SeedPriorsStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_priors.enabled': true } }))).toBe('ok');
  });

  it("returns 'ok' when no priors are available (catalog empty)", async () => {
    const seeder: IPriorsSeeder = {
      seedPriors: jest.fn().mockResolvedValue({ reason: 'no_priors_available', armsSeeded: 0, slotsConsidered: 6 }),
    };
    const step = new SeedPriorsStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_priors.enabled': true } }))).toBe('ok');
  });

  it("returns 'skipped' (re-attempts later) when mode is too low", async () => {
    const seeder: IPriorsSeeder = {
      seedPriors: jest.fn().mockResolvedValue({ reason: 'mode_too_low', armsSeeded: 0, slotsConsidered: 0 }),
    };
    const step = new SeedPriorsStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_priors.enabled': true } }))).toBe('skipped');
  });

  it("returns 'failed' when seeder reports failed", async () => {
    const seeder: IPriorsSeeder = {
      seedPriors: jest.fn().mockResolvedValue({ reason: 'failed', armsSeeded: 0, slotsConsidered: 0 }),
    };
    const step = new SeedPriorsStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_priors.enabled': true } }))).toBe('failed');
  });

  it("returns 'failed' when seeder throws", async () => {
    const seeder: IPriorsSeeder = {
      seedPriors: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new SeedPriorsStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_priors.enabled': true } }))).toBe('failed');
  });
});
