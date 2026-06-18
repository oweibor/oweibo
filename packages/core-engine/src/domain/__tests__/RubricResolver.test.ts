/**
 * D.2 — RubricResolver tests.
 */
import type { DomainRubric } from '@oweibo/core-contracts';
import { DomainRubricRegistry } from '../DomainRubricRegistry.js';
import { RubricResolver } from '../RubricResolver.js';

const rubric = (slug: string, id: string, kind = 'code_change'): DomainRubric => ({
  domainSlug: slug,
  rubricId: id,
  title: id,
  description: '',
  appliesToTaskKinds: [kind],
  weight: 0.5,
  version: '1.0',
  criteria: [],
});

describe('RubricResolver', () => {
  it('returns rubrics for every domain the tenant is bound to', async () => {
    const reg = new DomainRubricRegistry([rubric('fintech', 'a'), rubric('healthcare', 'b')]);
    const resolver = new RubricResolver(reg, async () => ['fintech', 'healthcare']);
    const out = await resolver.resolve({ tenantId: 't', taskKind: 'code_change' });
    expect(out.map((r) => r.rubricId).sort()).toEqual(['a', 'b']);
  });

  it('deduplicates by (domain, rubricId)', async () => {
    const reg = new DomainRubricRegistry([rubric('fintech', 'a')]);
    const resolver = new RubricResolver(reg, async () => ['fintech', 'fintech']);
    const out = await resolver.resolve({ tenantId: 't', taskKind: 'code_change' });
    expect(out).toHaveLength(1);
  });

  it('returns [] when the tenant has no bound domains and no default supplied', async () => {
    const reg = new DomainRubricRegistry([rubric('fintech', 'a')]);
    const resolver = new RubricResolver(reg, async () => []);
    const out = await resolver.resolve({ tenantId: 't', taskKind: 'code_change' });
    expect(out).toEqual([]);
  });

  it('falls back to defaultDomains when lookup returns []', async () => {
    const reg = new DomainRubricRegistry([rubric('fintech', 'a')]);
    const resolver = new RubricResolver(reg, async () => [], { defaultDomains: ['fintech'] });
    const out = await resolver.resolve({ tenantId: 't', taskKind: 'code_change' });
    expect(out.map((r) => r.rubricId)).toEqual(['a']);
  });

  it('lookup failure degrades to defaultDomains rather than throwing', async () => {
    const reg = new DomainRubricRegistry([rubric('fintech', 'a')]);
    const resolver = new RubricResolver(
      reg,
      async () => { throw new Error('db down'); },
      { defaultDomains: ['fintech'] },
    );
    const out = await resolver.resolve({ tenantId: 't', taskKind: 'code_change' });
    expect(out.map((r) => r.rubricId)).toEqual(['a']);
  });
});
