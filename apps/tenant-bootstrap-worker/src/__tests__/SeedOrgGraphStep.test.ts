/**
 * T.2.h — SeedOrgGraphStep tests.
 */
import type { Pool } from 'pg';
import { SeedOrgGraphStep, type IOrgGraphSeeder } from '../steps/SeedOrgGraphStep.js';
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

describe('SeedOrgGraphStep', () => {
  it('skips when feature flag is off', async () => {
    const seeder: IOrgGraphSeeder = { seed: jest.fn() };
    const step = new SeedOrgGraphStep({ seeder });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(seeder.seed).not.toHaveBeenCalled();
  });

  it('skips when seeder is not wired', async () => {
    const step = new SeedOrgGraphStep();
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.org_graph.enabled': true } }))).toBe('skipped');
  });

  it("returns 'ok' on a successful seed", async () => {
    const seeder: IOrgGraphSeeder = {
      seed: jest.fn().mockResolvedValue({
        creatorNodeId: 'c1', adminTeamNodeId: 't1', councilNodeId: 'co1',
        nodesCreated: 3, edgesCreated: 3,
      }),
    };
    const step = new SeedOrgGraphStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.org_graph.enabled': true } }))).toBe('ok');
  });

  it("returns 'ok' on an idempotent re-seed (0 nodes/edges created)", async () => {
    const seeder: IOrgGraphSeeder = {
      seed: jest.fn().mockResolvedValue({
        creatorNodeId: 'c1', adminTeamNodeId: 't1', councilNodeId: 'co1',
        nodesCreated: 0, edgesCreated: 0,
      }),
    };
    const step = new SeedOrgGraphStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.org_graph.enabled': true } }))).toBe('ok');
  });

  it("returns 'failed' when seeder throws", async () => {
    const seeder: IOrgGraphSeeder = {
      seed: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new SeedOrgGraphStep({ seeder });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.org_graph.enabled': true } }))).toBe('failed');
  });
});
