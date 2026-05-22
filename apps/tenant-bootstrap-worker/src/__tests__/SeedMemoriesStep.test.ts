/**
 * T.2.a — SeedMemoriesStep tests. Mock the catalog + writer; verify:
 *   - skips when feature flag off
 *   - skips when writer/catalog not wired
 *   - skips when catalog returns empty for the tenant
 *   - 'ok' when writer reports any inserted/skipped
 *   - 'failed' when writer reports nothing inserted/skipped but failures
 *   - 'failed' when writer throws
 *   - threads industry from features through to the catalog filter
 */
import type { Pool } from 'pg';
import { SeedMemoriesStep, type ISeedMemoryWriter, type ISeedCatalogProvider, type SeedMemoryRequest } from '../steps/SeedMemoriesStep.js';
import type { IBootstrapStepContext } from '../steps/IBootstrapStep.js';

const silentLogger = {
  info:  () => undefined,
  warn:  () => undefined,
  error: () => undefined,
};

function ctx(overrides: Partial<IBootstrapStepContext> = {}): IBootstrapStepContext {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    templateSlug: 'default',
    pool: {} as Pool,
    logger: silentLogger,
    features: overrides.features ?? {},
    ...overrides,
  } as IBootstrapStepContext;
}

const TWO_SEEDS: SeedMemoryRequest[] = [
  { seedId: 's1', catalogVersion: '1', kind: 'tool-heuristic', summary: 'a', importance: 0.5, tags: ['seed:s1'] },
  { seedId: 's2', catalogVersion: '1', kind: 'tool-heuristic', summary: 'b', importance: 0.5, tags: ['seed:s2'] },
];

function makeCatalog(returns: SeedMemoryRequest[]): ISeedCatalogProvider {
  return {
    forTenant: jest.fn().mockReturnValue(returns),
  } as unknown as ISeedCatalogProvider;
}

describe('SeedMemoriesStep', () => {
  it('skips when feature flag is off', async () => {
    const writer: ISeedMemoryWriter = { writeSeeds: jest.fn() };
    const step = new SeedMemoriesStep({ writer, catalog: makeCatalog(TWO_SEEDS) });
    expect(await step.execute(ctx())).toBe('skipped');
    expect(writer.writeSeeds).not.toHaveBeenCalled();
  });

  it('skips when writer is not wired', async () => {
    const step = new SeedMemoriesStep({ catalog: makeCatalog(TWO_SEEDS) });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('skipped');
  });

  it('skips when catalog is not wired', async () => {
    const step = new SeedMemoriesStep({ writer: { writeSeeds: jest.fn() } });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('skipped');
  });

  it('skips when catalog returns no entries for this tenant', async () => {
    const writer: ISeedMemoryWriter = { writeSeeds: jest.fn() };
    const step = new SeedMemoriesStep({ writer, catalog: makeCatalog([]) });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('skipped');
    expect(writer.writeSeeds).not.toHaveBeenCalled();
  });

  it("returns 'ok' when writer reports inserted entries", async () => {
    const writer: ISeedMemoryWriter = {
      writeSeeds: jest.fn().mockResolvedValue({ inserted: ['s1', 's2'], skipped: [], failed: [] }),
    };
    const step = new SeedMemoriesStep({ writer, catalog: makeCatalog(TWO_SEEDS) });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('ok');
  });

  it("returns 'ok' when writer reports only already-installed seeds (idempotent re-run)", async () => {
    const writer: ISeedMemoryWriter = {
      writeSeeds: jest.fn().mockResolvedValue({ inserted: [], skipped: ['s1', 's2'], failed: [] }),
    };
    const step = new SeedMemoriesStep({ writer, catalog: makeCatalog(TWO_SEEDS) });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('ok');
  });

  it("returns 'failed' when every seed failed", async () => {
    const writer: ISeedMemoryWriter = {
      writeSeeds: jest.fn().mockResolvedValue({ inserted: [], skipped: [], failed: ['s1', 's2'] }),
    };
    const step = new SeedMemoriesStep({ writer, catalog: makeCatalog(TWO_SEEDS) });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('failed');
  });

  it("returns 'failed' when writer throws", async () => {
    const writer: ISeedMemoryWriter = {
      writeSeeds: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new SeedMemoriesStep({ writer, catalog: makeCatalog(TWO_SEEDS) });
    expect(await step.execute(ctx({ features: { 'tenant.bootstrap.seed_memories.enabled': true } }))).toBe('failed');
  });

  it('threads industry from features into the catalog filter', async () => {
    const catalog = makeCatalog(TWO_SEEDS);
    const writer: ISeedMemoryWriter = {
      writeSeeds: jest.fn().mockResolvedValue({ inserted: ['s1'], skipped: [], failed: [] }),
    };
    const step = new SeedMemoriesStep({ writer, catalog });
    await step.execute(ctx({
      templateSlug: 'fintech-starter',
      features: { 'tenant.bootstrap.seed_memories.enabled': true, industry: 'fintech' },
    }));
    expect(catalog.forTenant).toHaveBeenCalledWith({ templateSlug: 'fintech-starter', industry: 'fintech' });
  });
});
