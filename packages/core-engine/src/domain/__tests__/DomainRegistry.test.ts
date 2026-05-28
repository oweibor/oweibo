/**
 * D.0 (domain-depth) — DomainRegistry tests.
 */
import { V1_DOMAIN_CATALOG } from '../domain-catalog/catalog.js';
import { DomainRegistry, type DomainCatalogRow } from '../DomainRegistry.js';

describe('DomainRegistry (v1 catalog defaults)', () => {
  const reg = new DomainRegistry();

  it('loads all 10 v1 domains', () => {
    expect(reg.list()).toHaveLength(10);
  });

  it('returns entries in slug-sorted order', () => {
    const slugs = reg.list().map((e) => e.slug);
    const sorted = [...slugs].sort();
    expect(slugs).toEqual(sorted);
  });

  it('catalog file count matches migration seed (1:1 invariant)', () => {
    // Migration 20260521_000032 inserts exactly 10 rows; this guards
    // against a drift where the bundled catalog and the SQL diverge.
    expect(V1_DOMAIN_CATALOG).toHaveLength(10);
  });

  it('has() returns true for a known slug, false for unknown', () => {
    expect(reg.has('fintech')).toBe(true);
    expect(reg.has('nope')).toBe(false);
  });

  it('get() returns the entry for a known slug', () => {
    const e = reg.get('fintech');
    expect(e).toBeDefined();
    expect(e?.displayName).toBe('Financial services');
    expect(e?.category).toBe('regulated');
  });

  it('get() returns undefined for an unknown slug', () => {
    expect(reg.get('not-a-domain')).toBeUndefined();
  });

  it('require() throws for an unknown slug', () => {
    expect(() => reg.require('not-a-domain')).toThrow(/unknown domain slug/);
  });

  it('require() returns the entry for a known slug', () => {
    expect(reg.require('devops').slug).toBe('devops');
  });

  it('listByMaturity(beta) returns only beta-tier entries', () => {
    const beta = reg.listByMaturity('beta');
    expect(beta.length).toBeGreaterThan(0);
    for (const e of beta) expect(e.maturity).toBe('beta');
  });

  it('listByMaturity(experimental, beta) returns the union', () => {
    const both = reg.listByMaturity('experimental', 'beta');
    for (const e of both) {
      expect(['experimental', 'beta']).toContain(e.maturity);
    }
    expect(both.length).toBeGreaterThanOrEqual(reg.listByMaturity('beta').length);
  });

  it('listByMaturity() with no args returns []', () => {
    expect(reg.listByMaturity()).toEqual([]);
  });
});

describe('DomainRegistry — validation', () => {
  it('rejects duplicate slugs', () => {
    const dup = [V1_DOMAIN_CATALOG[0]!, V1_DOMAIN_CATALOG[0]!];
    expect(() => new DomainRegistry(dup)).toThrow(/duplicate slug/);
  });

  it('rejects an invalid category', () => {
    const bad = [{ ...V1_DOMAIN_CATALOG[0]!, category: 'made-up' as never }];
    expect(() => new DomainRegistry(bad)).toThrow(/invalid category/);
  });

  it('rejects an invalid maturity', () => {
    const bad = [{ ...V1_DOMAIN_CATALOG[0]!, maturity: 'gold-tier' as never }];
    expect(() => new DomainRegistry(bad)).toThrow(/invalid maturity/);
  });
});

describe('DomainRegistry.fromRows', () => {
  it('translates pg row casing to camelCase contract', () => {
    const rows: DomainCatalogRow[] = [
      {
        slug: 'fintech',
        display_name: 'Financial services',
        description: 'Banking, payments',
        category: 'regulated',
        compliance_postures: ['PCI-DSS'],
        archetype_roles: ['CFO'],
        typical_connectors: ['stripe'],
        canonical_verbiage: ['payment'],
        registry_version: '1.0.0',
        maturity: 'beta',
        depth_targets: { ontologyEntries: 300 },
        created_at: new Date('2026-05-21T00:00:00Z'),
        updated_at: new Date('2026-05-21T00:00:00Z'),
      },
    ];
    const reg = DomainRegistry.fromRows(rows);
    const e = reg.require('fintech');
    expect(e.displayName).toBe('Financial services');
    expect(e.compliancePostures).toEqual(['PCI-DSS']);
    expect(e.depthTargets.ontologyEntries).toBe(300);
    expect(e.createdAt).toBe('2026-05-21T00:00:00.000Z');
  });

  it('coalesces null array columns to []', () => {
    const rows: DomainCatalogRow[] = [
      {
        slug: 'sparse',
        display_name: 'Sparse',
        description: 'Minimal',
        category: 'technical',
        compliance_postures: null,
        archetype_roles: null,
        typical_connectors: null,
        canonical_verbiage: null,
        registry_version: '1.0.0',
        maturity: 'experimental',
        depth_targets: null,
      },
    ];
    const reg = DomainRegistry.fromRows(rows);
    const e = reg.require('sparse');
    expect(e.compliancePostures).toEqual([]);
    expect(e.archetypeRoles).toEqual([]);
    expect(e.depthTargets).toEqual({});
  });
});
