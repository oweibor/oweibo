/**
 * T.7 — isRetiredSeedTagged predicate tests + smoke test that
 * PlatformSeedCatalog.normalize computes a stable content hash.
 */
import { isRetiredSeedTagged } from '../seedTags.js';
import { PlatformSeedCatalog, computeContentHash } from '../../../seed/PlatformSeedCatalog.js';

describe('isRetiredSeedTagged', () => {
  it('false for undefined / empty / organic tags', () => {
    expect(isRetiredSeedTagged(undefined)).toBe(false);
    expect(isRetiredSeedTagged([])).toBe(false);
    expect(isRetiredSeedTagged(['language:typescript'])).toBe(false);
  });

  it('true when a seed:retired:* tag is present', () => {
    expect(isRetiredSeedTagged(['seed:abc', 'seed:retired:removed_from_catalog'])).toBe(true);
  });

  it('false when only generic seed: tags are present', () => {
    expect(isRetiredSeedTagged(['seed:abc', 'seed:catalog:1'])).toBe(false);
  });

  it('ignores non-string values defensively', () => {
    expect(isRetiredSeedTagged([null as unknown as string])).toBe(false);
  });
});

describe('computeContentHash', () => {
  it('is deterministic for the same logical payload regardless of tag order', () => {
    const a = computeContentHash({
      kind: 'tool-heuristic', summary: 's', importance: 0.5, tags: ['a', 'b', 'c'],
    });
    const b = computeContentHash({
      kind: 'tool-heuristic', summary: 's', importance: 0.5, tags: ['c', 'a', 'b'],
    });
    expect(a).toBe(b);
  });

  it('changes when the summary changes', () => {
    const a = computeContentHash({ kind: 'tool-heuristic', summary: 'one', importance: 0.5, tags: [] });
    const b = computeContentHash({ kind: 'tool-heuristic', summary: 'two', importance: 0.5, tags: [] });
    expect(a).not.toBe(b);
  });
});

describe('PlatformSeedCatalog.normalize sets contentHash', () => {
  it('every loaded entry has a SHA-256 hex contentHash', async () => {
    const catalog = await PlatformSeedCatalog.loadFromDirectory(
      // The default directory is resolved from the dist path at runtime; in
      // tests we cross-reference the source tree.
      require('path').join(__dirname, '..', '..', '..', 'seed', 'seed-memories'),
    );
    expect(catalog.size).toBeGreaterThan(0);
    for (const e of catalog.all()) {
      expect(e.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('a pure version-string bump does NOT change the contentHash', () => {
    const cat1 = PlatformSeedCatalog.fromEntries([{
      seedId: 's1', catalogVersion: '1', kind: 'tool-heuristic',
      summary: 'x', importance: 0.5, tags: ['scope:starter'],
      applicableTo: { templates: ['*'] }, contentHash: '',
    }]);
    const cat2 = PlatformSeedCatalog.fromEntries([{
      seedId: 's1', catalogVersion: '2', kind: 'tool-heuristic',
      summary: 'x', importance: 0.5, tags: ['scope:starter'],
      applicableTo: { templates: ['*'] }, contentHash: '',
    }]);
    expect(cat1.all()[0]?.contentHash).toBe(cat2.all()[0]?.contentHash);
  });

  it('a summary change DOES change the contentHash', () => {
    const cat1 = PlatformSeedCatalog.fromEntries([{
      seedId: 's1', catalogVersion: '1', kind: 'tool-heuristic',
      summary: 'one', importance: 0.5, tags: [],
      applicableTo: { templates: ['*'] }, contentHash: '',
    }]);
    const cat2 = PlatformSeedCatalog.fromEntries([{
      seedId: 's1', catalogVersion: '1', kind: 'tool-heuristic',
      summary: 'two', importance: 0.5, tags: [],
      applicableTo: { templates: ['*'] }, contentHash: '',
    }]);
    expect(cat1.all()[0]?.contentHash).not.toBe(cat2.all()[0]?.contentHash);
  });
});
