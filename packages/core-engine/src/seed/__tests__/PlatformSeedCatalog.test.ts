/**
 * T.2.a — PlatformSeedCatalog tests.
 *
 * Covers: directory loading, template/industry filtering, seed-marker tags,
 * importance cap, duplicate-seedId detection, and entry validation.
 */
import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';
import { PlatformSeedCatalog, type PlatformSeedMemory } from '../PlatformSeedCatalog.js';

const SEED_DIR = path.join(__dirname, '..', 'seed-memories');

describe('PlatformSeedCatalog.loadFromDirectory', () => {
  it('loads every JSON file shipped with the package', async () => {
    const catalog = await PlatformSeedCatalog.loadFromDirectory(SEED_DIR);
    expect(catalog.size).toBeGreaterThan(0);
  });

  it('every loaded entry has seed:<id> and seed:catalog:<version> marker tags', async () => {
    const catalog = await PlatformSeedCatalog.loadFromDirectory(SEED_DIR);
    for (const e of catalog.all()) {
      expect(e.tags).toContain(`seed:${e.seedId}`);
      expect(e.tags).toContain(`seed:catalog:${e.catalogVersion}`);
    }
  });

  it('caps importance at 0.6 even if a catalog entry exceeds the cap', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'seedcat-'));
    try {
      await fs.writeFile(path.join(tmp, 'cap.json'), JSON.stringify({
        entries: [{
          seedId: 'cap-test',
          catalogVersion: '1',
          kind: 'tool-heuristic',
          summary: 'test',
          importance: 0.99,
          tags: [],
          applicableTo: { templates: ['*'] },
        }],
      }));
      const catalog = await PlatformSeedCatalog.loadFromDirectory(tmp);
      expect(catalog.all()[0]?.importance).toBe(0.6);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws on duplicate seedId across files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'seedcat-dup-'));
    try {
      const dupe: PlatformSeedMemory = {
        seedId: 'dup',
        catalogVersion: '1',
        kind: 'tool-heuristic',
        summary: 'x',
        importance: 0.5,
        tags: [],
        applicableTo: { templates: ['*'] },
      };
      await fs.writeFile(path.join(tmp, 'a.json'), JSON.stringify({ entries: [dupe] }));
      await fs.writeFile(path.join(tmp, 'b.json'), JSON.stringify({ entries: [dupe] }));
      await expect(PlatformSeedCatalog.loadFromDirectory(tmp)).rejects.toThrow(/duplicate seedId/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws on malformed entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'seedcat-bad-'));
    try {
      await fs.writeFile(path.join(tmp, 'bad.json'), JSON.stringify({
        entries: [{ seedId: '', catalogVersion: '1', kind: 'x', summary: 'y', importance: 0.5, tags: [], applicableTo: { templates: ['*'] } }],
      }));
      await expect(PlatformSeedCatalog.loadFromDirectory(tmp)).rejects.toThrow(/missing required string/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty catalog when directory missing', async () => {
    const tmp = path.join(os.tmpdir(), 'definitely-not-a-real-seedcat-dir-' + Date.now());
    const catalog = await PlatformSeedCatalog.loadFromDirectory(tmp);
    expect(catalog.size).toBe(0);
  });
});

describe('PlatformSeedCatalog.forTenant', () => {
  function makeEntry(overrides: Partial<PlatformSeedMemory> = {}): PlatformSeedMemory {
    // Audit-fix (T.7): summary derived from seedId so each test entry
    // hashes uniquely. The dedup gate in PlatformSeedCatalog now
    // rejects identical-content entries with different seedIds; pre-fix
    // the fixture leaned on duplicate 'test' summaries.
    return {
      seedId: overrides.seedId ?? 'test',
      catalogVersion: '1',
      kind: 'tool-heuristic',
      summary: overrides.summary ?? `summary for ${overrides.seedId ?? 'test'}`,
      importance: 0.5,
      tags: [],
      applicableTo: overrides.applicableTo ?? { templates: ['*'] },
    };
  }

  it('returns wildcard entries for any template', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'a', applicableTo: { templates: ['*'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'anything' })).toHaveLength(1);
  });

  it('filters by explicit template', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'a', applicableTo: { templates: ['nextjs-app'] } }),
      makeEntry({ seedId: 'b', applicableTo: { templates: ['cli-tool'] } }),
    ]);
    const out = cat.forTenant({ templateSlug: 'nextjs-app' });
    expect(out.map((e) => e.seedId)).toEqual(['a']);
  });

  it('industry filter excludes when industry is required but absent', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'a', applicableTo: { templates: ['*'], industries: ['fintech'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x' })).toHaveLength(0);
  });

  it('industry filter matches when tenant industry is in the list', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'a', applicableTo: { templates: ['*'], industries: ['fintech'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x', industry: 'fintech' })).toHaveLength(1);
  });

  it('industry filter excludes a tenant whose industry is not listed', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'a', applicableTo: { templates: ['*'], industries: ['fintech'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x', industry: 'healthcare' })).toHaveLength(0);
  });

  // T.8 — region filter
  it('region filter is skipped when caller omits homeRegion (today\'s behaviour)', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'a', applicableTo: { templates: ['*'], regions: ['eu-*'] } }),
    ]);
    // No homeRegion in filter → region-tagged entry still matches.
    expect(cat.forTenant({ templateSlug: 'x' })).toHaveLength(1);
  });

  it('region filter matches concrete tenant region', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'us', applicableTo: { templates: ['*'], regions: ['us-east-1'] } }),
      makeEntry({ seedId: 'eu', applicableTo: { templates: ['*'], regions: ['eu-central-1'] } }),
    ]);
    const out = cat.forTenant({ templateSlug: 'x', homeRegion: 'us-east-1' });
    expect(out.map((e) => e.seedId)).toEqual(['us']);
  });

  it('region filter matches glob (eu-* matches eu-central-1)', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'eu', applicableTo: { templates: ['*'], regions: ['eu-*'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x', homeRegion: 'eu-central-1' })).toHaveLength(1);
    expect(cat.forTenant({ templateSlug: 'x', homeRegion: 'us-east-1' })).toHaveLength(0);
  });

  it('neutral region marker "*" matches any tenant', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'neutral', applicableTo: { templates: ['*'], regions: ['*'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x', homeRegion: 'eu-central-1' })).toHaveLength(1);
    expect(cat.forTenant({ templateSlug: 'x', homeRegion: 'us-east-1' })).toHaveLength(1);
  });

  it('region-locked entry is unreachable from non-matching region (privacy invariant)', () => {
    const cat = PlatformSeedCatalog.fromEntries([
      makeEntry({ seedId: 'eu-locked', applicableTo: { templates: ['*'], regions: ['eu-*'] } }),
    ]);
    expect(cat.forTenant({ templateSlug: 'x', homeRegion: 'us-east-1' })).toHaveLength(0);
    expect(cat.forTenant({ templateSlug: 'x', homeRegion: 'ap-southeast-2' })).toHaveLength(0);
  });
});
