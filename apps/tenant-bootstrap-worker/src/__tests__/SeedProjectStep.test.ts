/**
 * T.2.b — SeedProjectStep unit tests. Mock IProjectSeeder + spec resolver.
 */
import type { Pool } from 'pg';
import {
  SeedProjectStep,
  type IProjectSeeder,
  type StarterProjectInvariants,
} from '../steps/SeedProjectStep.js';
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

const SPEC: StarterProjectInvariants = {
  name: 'Default',
  description: 'Starter project — rename or archive as needed.',
  invariants: { language: 'typescript' },
  tags: ['scope:starter'],
};

describe('SeedProjectStep', () => {
  it('skips when feature flag is off', async () => {
    const seeder: IProjectSeeder = { seedStarterProject: jest.fn() };
    const step = new SeedProjectStep({ seeder, resolveSpec: () => SPEC });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(seeder.seedStarterProject).not.toHaveBeenCalled();
  });

  it('skips when seeder is not wired', async () => {
    const step = new SeedProjectStep({ resolveSpec: () => SPEC });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_project.enabled': true } }))).toBe('skipped');
  });

  it('skips when spec resolver is not wired', async () => {
    const seeder: IProjectSeeder = { seedStarterProject: jest.fn() };
    const step = new SeedProjectStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_project.enabled': true } }))).toBe('skipped');
  });

  it("returns 'ok' on inserted", async () => {
    const seeder: IProjectSeeder = {
      seedStarterProject: jest.fn().mockResolvedValue({ projectId: 'p1', status: 'inserted' }),
    };
    const step = new SeedProjectStep({ seeder, resolveSpec: () => SPEC });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_project.enabled': true } }))).toBe('ok');
  });

  it("returns 'ok' on already_present (idempotent re-run)", async () => {
    const seeder: IProjectSeeder = {
      seedStarterProject: jest.fn().mockResolvedValue({ projectId: 'p1', status: 'already_present' }),
    };
    const step = new SeedProjectStep({ seeder, resolveSpec: () => SPEC });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_project.enabled': true } }))).toBe('ok');
  });

  it("returns 'failed' with seeder reason in message when seeder reports failed", async () => {
    const seeder: IProjectSeeder = {
      seedStarterProject: jest.fn().mockResolvedValue({ projectId: null, status: 'failed', reason: 'redis down' }),
    };
    const step = new SeedProjectStep({ seeder, resolveSpec: () => SPEC });
    const result = await step.execute(ctx({ features: { 'tenant.bootstrap.seed_project.enabled': true } }));
    // F.7 review: structured StepResult preserves the seeder's reason as last_error.
    expect(result).toEqual({ status: 'failed', message: 'redis down' });
  });

  it("returns 'failed' when seeder throws", async () => {
    const seeder: IProjectSeeder = {
      seedStarterProject: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new SeedProjectStep({ seeder, resolveSpec: () => SPEC });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_project.enabled': true } }))).toBe('failed');
  });

  it('threads tenant template into the spec resolver', async () => {
    const resolver = jest.fn().mockReturnValue(SPEC);
    const seeder: IProjectSeeder = {
      seedStarterProject: jest.fn().mockResolvedValue({ projectId: 'p1', status: 'inserted' }),
    };
    const step = new SeedProjectStep({ seeder, resolveSpec: resolver });
    await step.execute(ctx({
      templateSlug: 'python-app',
      features: { 'tenant.bootstrap.seed_project.enabled': true },
    }));
    expect(resolver).toHaveBeenCalledWith('python-app');
  });
});
