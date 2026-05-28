/**
 * D.2 — DomainRubricRegistry tests.
 */
import type { DomainRubric } from '@oweibo/core-contracts';
import { DomainRubricRegistry, V1_DOMAIN_RUBRICS } from '../DomainRubricRegistry.js';

const stub = (slug: string, id: string, taskKinds: string[] = ['code_change']): DomainRubric => ({
  domainSlug: slug,
  rubricId: id,
  title: id,
  description: '',
  appliesToTaskKinds: taskKinds,
  weight: 0.5,
  version: '1.0',
  criteria: [],
});

describe('DomainRubricRegistry — defaults', () => {
  const reg = new DomainRubricRegistry();

  it('loads v1 rubrics across 5 domains (fintech, healthcare, legal, ml-research, devops)', () => {
    expect(V1_DOMAIN_RUBRICS.length).toBeGreaterThanOrEqual(11);
    const domains = new Set(V1_DOMAIN_RUBRICS.map((r) => r.domainSlug));
    for (const d of ['fintech', 'healthcare', 'legal', 'ml-research', 'devops']) {
      expect(domains.has(d)).toBe(true);
    }
  });

  it('forDomain returns the rubrics for a domain only', () => {
    const fintech = reg.forDomain('fintech');
    expect(fintech.length).toBeGreaterThan(0);
    for (const r of fintech) expect(r.domainSlug).toBe('fintech');
  });

  it('forDomain returns [] for an unknown domain', () => {
    expect(reg.forDomain('nope')).toEqual([]);
  });

  it('forDomainAndTaskKind filters by appliesToTaskKinds', () => {
    const matchesCode = reg
      .forDomainAndTaskKind('fintech', 'code_change')
      .every((r) => r.appliesToTaskKinds.includes('code_change'));
    expect(matchesCode).toBe(true);
    const empty = reg.forDomainAndTaskKind('fintech', 'no_such_kind');
    expect(empty).toEqual([]);
  });
});

describe('DomainRubricRegistry — validation', () => {
  it('rejects duplicate (domain, rubricId) pairs', () => {
    expect(() => new DomainRubricRegistry([stub('x', 'a'), stub('x', 'a')])).toThrow(/duplicate/);
  });

  it('allows the same rubricId across different domains', () => {
    expect(
      () => new DomainRubricRegistry([stub('x', 'a'), stub('y', 'a')]),
    ).not.toThrow();
  });
});
