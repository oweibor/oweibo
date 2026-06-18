/**
 * F.5.9 — JsonSeedCatalogProvider tests.
 */
import { PlatformSeedCatalog, type PlatformSeedMemory } from '../../PlatformSeedCatalog.js';
import { JsonSeedCatalogProvider } from '../JsonSeedCatalogProvider.js';

function entry(seedId: string, opts: Partial<PlatformSeedMemory> = {}): PlatformSeedMemory {
  return {
    seedId,
    catalogVersion: 'v1',
    kind: 'episodic',
    summary: `${seedId} summary`,
    importance: 0.5,
    tags: [`seed:${seedId}`],
    applicableTo: { templates: ['*'], ...(opts.applicableTo ?? {}) },
    contentHash: 'placeholder',
    ...opts,
  } as PlatformSeedMemory;
}

describe('JsonSeedCatalogProvider', () => {
  it('maps each filtered PlatformSeedMemory to a SeedMemoryRequest', () => {
    const catalog = PlatformSeedCatalog.fromEntries([
      entry('intro'),
      entry('fintech', { applicableTo: { templates: ['*'], industries: ['fintech'] } }),
    ]);
    const provider = new JsonSeedCatalogProvider(catalog);

    const out = provider.forTenant({ templateSlug: 'default' });
    expect(out.map((s) => s.seedId)).toEqual(['intro']);
    expect(out[0]).toMatchObject({
      seedId: 'intro',
      catalogVersion: 'v1',
      kind: 'episodic',
      summary: 'intro summary',
      importance: 0.5,
    });
    expect(out[0]!.tags).toEqual(expect.arrayContaining(['seed:intro']));
    // applicableTo + contentHash are catalog-internal and must not leak.
    expect(out[0]).not.toHaveProperty('applicableTo');
    expect(out[0]).not.toHaveProperty('contentHash');
  });

  it('honors industry filter when supplied', () => {
    const catalog = PlatformSeedCatalog.fromEntries([
      entry('a', { applicableTo: { templates: ['*'], industries: ['fintech'] } }),
      entry('b', { applicableTo: { templates: ['*'], industries: ['healthcare'] } }),
    ]);
    const provider = new JsonSeedCatalogProvider(catalog);

    expect(provider.forTenant({ templateSlug: 'default', industry: 'fintech' }).map((s) => s.seedId))
      .toEqual(['a']);
  });

  it('drops optional body when not present', () => {
    const catalog = PlatformSeedCatalog.fromEntries([entry('no-body')]);
    const out = new JsonSeedCatalogProvider(catalog).forTenant({ templateSlug: 'default' });
    expect(out[0]).not.toHaveProperty('body');
  });

  it('forwards body when present', () => {
    const catalog = PlatformSeedCatalog.fromEntries([entry('with-body', { body: 'detail' } as never)]);
    const out = new JsonSeedCatalogProvider(catalog).forTenant({ templateSlug: 'default' });
    expect(out[0]!.body).toBe('detail');
  });

  it('threads homeRegion through to the catalog filter', () => {
    const catalog = PlatformSeedCatalog.fromEntries([
      entry('us-only', { applicableTo: { templates: ['*'], regions: ['us-east-1'] } }),
      entry('eu-only', { applicableTo: { templates: ['*'], regions: ['eu-west-1'] } }),
    ]);
    const provider = new JsonSeedCatalogProvider(catalog);

    expect(provider.forTenant({ templateSlug: 'default', homeRegion: 'us-east-1' }).map((s) => s.seedId))
      .toEqual(['us-only']);
  });
});
