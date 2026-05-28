/**
 * D.1 (domain-depth) — OntologyPackRegistry tests.
 */
import type { OntologyPack } from '@oweibo/core-contracts';
import { DomainRegistry } from '../DomainRegistry.js';
import { OntologyPackRegistry, V1_ONTOLOGY_PACKS } from '../OntologyPackRegistry.js';

const minimalPack = (slug: string): OntologyPack => ({
  domainSlug: slug,
  packVersion: '1.0.0-stub',
  registryVersion: '1.0.0',
  glossary: [
    { term: 'AC', definition: 'alpha centauri', aliases: ['ac', 'AlphaC'], category: 'astro' },
  ],
  namedEntities: [],
  terminology: [],
  disambiguations: [
    {
      ambiguousTerm: 'AC',
      senses: [
        { meaning: 'air conditioning', contextTriggers: ['temperature', 'cool'], weight: 1.0 },
        { meaning: 'alternating current', contextTriggers: ['voltage', 'circuit'], weight: 1.0 },
      ],
      defaultSense: 'air conditioning',
    },
  ],
  metadata: {
    authoredBy: 'test',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    sourceRefs: [],
  },
});

describe('OntologyPackRegistry — defaults', () => {
  const reg = new OntologyPackRegistry();

  it('loads all 10 v1 ontology packs', () => {
    expect(V1_ONTOLOGY_PACKS).toHaveLength(10);
    expect(reg.list()).toHaveLength(10);
  });

  it('returns entries sorted by slug', () => {
    const slugs = reg.list().map((p) => p.domainSlug);
    expect(slugs).toEqual([...slugs].sort());
  });

  it('every v1 pack has a corresponding domain in the canonical registry', () => {
    const domains = new DomainRegistry();
    for (const pack of V1_ONTOLOGY_PACKS) {
      expect(domains.has(pack.domainSlug)).toBe(true);
    }
  });

  it('get() returns the pack for a known slug', () => {
    const pack = reg.get('fintech');
    expect(pack).toBeDefined();
    expect(pack?.glossary.some((g) => g.term === 'NAV')).toBe(true);
  });

  it('get() returns undefined for an unknown slug', () => {
    expect(reg.get('not-a-domain')).toBeUndefined();
  });
});

describe('OntologyPackRegistry — validation', () => {
  it('rejects duplicate pack slugs', () => {
    expect(() => new OntologyPackRegistry([minimalPack('x'), minimalPack('x')])).toThrow(
      /duplicate pack/,
    );
  });

  it('rejects pack whose slug is not in the domain registry, when a registry is supplied', () => {
    const domains = new DomainRegistry();
    expect(
      () => new OntologyPackRegistry([minimalPack('not-a-domain')], { domainRegistry: domains }),
    ).toThrow(/not in the canonical registry/);
  });

  it('rejects pack whose registryVersion drifts from the catalog entry', () => {
    const domains = new DomainRegistry();
    const drifted: OntologyPack = { ...minimalPack('fintech'), registryVersion: '0.0.1' };
    expect(() => new OntologyPackRegistry([drifted], { domainRegistry: domains })).toThrow(
      /registryVersion/,
    );
  });

  it('accepts every v1 pack when validated against the v1 catalog', () => {
    const domains = new DomainRegistry();
    expect(
      () => new OntologyPackRegistry(V1_ONTOLOGY_PACKS, { domainRegistry: domains }),
    ).not.toThrow();
  });
});

describe('OntologyPackRegistry — disambiguation', () => {
  const reg = new OntologyPackRegistry([minimalPack('test')]);

  it('returns the highest-weight sense whose triggers match', () => {
    const r = reg.getDisambiguation('test', 'AC', ['voltage', 'wiring', 'circuit']);
    expect(r).toBeDefined();
    expect(r?.sense).toBe('alternating current');
    expect(r?.score).toBeGreaterThan(0);
    expect(r?.usedDefault).toBe(false);
  });

  it('matches triggers case-insensitively', () => {
    const r = reg.getDisambiguation('test', 'AC', ['TEMPERATURE']);
    expect(r?.sense).toBe('air conditioning');
  });

  it('falls back to defaultSense when no triggers match', () => {
    const r = reg.getDisambiguation('test', 'AC', ['cucumber']);
    expect(r).toBeDefined();
    expect(r?.sense).toBe('air conditioning');
    expect(r?.usedDefault).toBe(true);
    expect(r?.score).toBe(0);
  });

  it('returns undefined when the term has no disambiguation rule', () => {
    expect(reg.getDisambiguation('test', 'WAT', ['anything'])).toBeUndefined();
  });

  it('returns undefined when the domain has no pack', () => {
    expect(reg.getDisambiguation('not-a-domain', 'AC', [])).toBeUndefined();
  });
});

describe('OntologyPackRegistry — findGlossaryTerm', () => {
  const reg = new OntologyPackRegistry([minimalPack('test')]);

  it('finds entries by canonical term (case-insensitive)', () => {
    expect(reg.findGlossaryTerm('test', 'ac')?.term).toBe('AC');
  });

  it('finds entries by alias', () => {
    expect(reg.findGlossaryTerm('test', 'AlphaC')?.term).toBe('AC');
  });

  it('returns undefined for unknown term', () => {
    expect(reg.findGlossaryTerm('test', 'unknown')).toBeUndefined();
  });
});
