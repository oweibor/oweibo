/**
 * T.2.f — SeedConnectorsStep tests. Mock the recommender.
 */
import type { Pool } from 'pg';
import {
  SeedConnectorsStep,
  type IConnectorRecommender,
} from '../steps/SeedConnectorsStep.js';
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

describe('SeedConnectorsStep', () => {
  it('skips when feature flag is off', async () => {
    const rec: IConnectorRecommender = { recommend: jest.fn() };
    const step = new SeedConnectorsStep({ recommender: rec });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(rec.recommend).not.toHaveBeenCalled();
  });

  it('skips when recommender is not wired', async () => {
    const step = new SeedConnectorsStep();
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_connectors.enabled': true } }))).toBe('skipped');
  });

  it("returns 'ok' when recommender returns any recommendations", async () => {
    const rec: IConnectorRecommender = {
      recommend: jest.fn().mockResolvedValue([
        { connectorId: 'slack', displayName: 'Slack' },
      ]),
    };
    const step = new SeedConnectorsStep({ recommender: rec });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_connectors.enabled': true } }))).toBe('ok');
  });

  it("returns 'ok' even when recommender returns an empty list", async () => {
    const rec: IConnectorRecommender = {
      recommend: jest.fn().mockResolvedValue([]),
    };
    const step = new SeedConnectorsStep({ recommender: rec });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_connectors.enabled': true } }))).toBe('ok');
  });

  it("returns 'failed' when recommender throws", async () => {
    const rec: IConnectorRecommender = {
      recommend: jest.fn().mockRejectedValue(new Error('catalog unreadable')),
    };
    const step = new SeedConnectorsStep({ recommender: rec });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_connectors.enabled': true } }))).toBe('failed');
  });

  it('threads template + industry into the recommender', async () => {
    const rec: IConnectorRecommender = {
      recommend: jest.fn().mockResolvedValue([]),
    };
    const step = new SeedConnectorsStep({ recommender: rec });
    await step.execute(ctx({
      templateSlug: 'fintech-smb',
      features: { 'tenant.bootstrap.seed_connectors.enabled': true, industry: 'fintech' },
    }));
    expect(rec.recommend).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'fintech-smb',
      'fintech',
    );
  });
});
