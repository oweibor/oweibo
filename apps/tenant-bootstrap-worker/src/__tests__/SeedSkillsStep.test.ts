/**
 * T.2.c — SeedSkillsStep unit tests. Mock ISkillSeeder.
 */
import type { Pool } from 'pg';
import { SeedSkillsStep, type ISkillSeeder } from '../steps/SeedSkillsStep.js';
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

const BUNDLE = '/tmp/seed-bundle';

describe('SeedSkillsStep', () => {
  beforeEach(() => {
    delete process.env['OWEIBO_SEED_SKILL_BUNDLE_PATH'];
  });

  it('skips when feature flag is off', async () => {
    const seeder: ISkillSeeder = { seedSkills: jest.fn() };
    const step = new SeedSkillsStep({ seeder, bundlePath: BUNDLE });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(seeder.seedSkills).not.toHaveBeenCalled();
  });

  it('skips when seeder is not wired', async () => {
    const step = new SeedSkillsStep({ bundlePath: BUNDLE });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('skipped');
  });

  it('skips when neither bundlePath option nor env is set', async () => {
    const seeder: ISkillSeeder = { seedSkills: jest.fn() };
    const step = new SeedSkillsStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('skipped');
    expect(seeder.seedSkills).not.toHaveBeenCalled();
  });

  it('falls back to OWEIBO_SEED_SKILL_BUNDLE_PATH env when option is omitted', async () => {
    process.env['OWEIBO_SEED_SKILL_BUNDLE_PATH'] = '/env-bundle';
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockResolvedValue({ registered: ['a'], failed: [] }),
    };
    const step = new SeedSkillsStep({ seeder });
    await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }));
    expect(seeder.seedSkills).toHaveBeenCalledWith(expect.any(String), '/env-bundle');
  });

  it("returns 'ok' when any skill registers", async () => {
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockResolvedValue({ registered: ['s1', 's2'], failed: [] }),
    };
    const step = new SeedSkillsStep({ seeder, bundlePath: BUNDLE });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('ok');
  });

  it("returns 'ok' with empty registered + empty failed (idempotent re-run on a tenant with all skills already present)", async () => {
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockResolvedValue({ registered: [], failed: [] }),
    };
    const step = new SeedSkillsStep({ seeder, bundlePath: BUNDLE });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('ok');
  });

  it("returns 'failed' when every skill failed", async () => {
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockResolvedValue({ registered: [], failed: ['s1', 's2'] }),
    };
    const step = new SeedSkillsStep({ seeder, bundlePath: BUNDLE });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('failed');
  });

  it("returns 'ok' on partial failure (some registered, some failed)", async () => {
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockResolvedValue({ registered: ['s1'], failed: ['s2'] }),
    };
    const step = new SeedSkillsStep({ seeder, bundlePath: BUNDLE });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('ok');
  });

  it("returns 'failed' when seeder throws", async () => {
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new SeedSkillsStep({ seeder, bundlePath: BUNDLE });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }))).toBe('failed');
  });

  it('option bundle path beats the env when both are set', async () => {
    process.env['OWEIBO_SEED_SKILL_BUNDLE_PATH'] = '/env-bundle';
    const seeder: ISkillSeeder = {
      seedSkills: jest.fn().mockResolvedValue({ registered: ['a'], failed: [] }),
    };
    const step = new SeedSkillsStep({ seeder, bundlePath: '/opt-bundle' });
    await step.execute(ctx({ features: { 'tenant.bootstrap.seed_skills.enabled': true } }));
    expect(seeder.seedSkills).toHaveBeenCalledWith(expect.any(String), '/opt-bundle');
  });
});
