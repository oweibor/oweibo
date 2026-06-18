/**
 * T.2.g — DomainClassifier tests.
 */
import {
  DomainClassifier,
  cosineSimilarity,
  type DomainOntologyEntry,
  type QueryEmbedder,
} from '../DomainClassifier.js';

const FINANCE: DomainOntologyEntry = {
  domain: 'finance',
  displayName: 'Finance',
  embedding: [1, 0, 0],
  recommendedTemplate: 'fintech-smb',
  recommendedConnectors: ['stripe', 'plaid'],
};
const HEALTHCARE: DomainOntologyEntry = {
  domain: 'healthcare',
  displayName: 'Healthcare',
  embedding: [0, 1, 0],
  recommendedTemplate: 'healthcare-clinic',
  recommendedConnectors: ['epic', 'twilio'],
};

function embedder(v: readonly number[]): QueryEmbedder {
  return async () => v;
}

describe('DomainClassifier', () => {
  it('classifies finance when query embeds align with finance', async () => {
    const c = new DomainClassifier([FINANCE, HEALTHCARE], embedder([1, 0, 0]));
    const out = await c.classify('we handle payments and reconciliation');
    expect(out.domain).toBe('finance');
    expect(out.confidence).toBe(1);
    expect(out.recommendedTemplate).toBe('fintech-smb');
    expect(out.recommendedConnectors).toEqual(['stripe', 'plaid']);
  });

  it('returns unclassified when below threshold', async () => {
    const c = new DomainClassifier([FINANCE], embedder([0, 1, 0]), { threshold: 0.7 });
    const out = await c.classify('something unrelated');
    expect(out.domain).toBe('unclassified');
    expect(out.recommendedTemplate).toBeNull();
    expect(out.recommendedConnectors).toEqual([]);
  });

  it('returns unclassified for empty intake text', async () => {
    const c = new DomainClassifier([FINANCE], embedder([1, 0, 0]));
    const out = await c.classify('');
    expect(out.domain).toBe('unclassified');
  });

  it('returns unclassified when ontology is empty', async () => {
    const c = new DomainClassifier([], embedder([1, 0, 0]));
    const out = await c.classify('anything');
    expect(out.domain).toBe('unclassified');
  });

  it('skips entries with mismatched embedding dimensions', async () => {
    const wrongDim: DomainOntologyEntry = { ...FINANCE, embedding: [1, 0] };
    const c = new DomainClassifier([wrongDim, HEALTHCARE], embedder([0, 1, 0]), { threshold: 0.5 });
    const out = await c.classify('healthcare query');
    expect(out.domain).toBe('healthcare');
  });

  it('honors custom threshold', async () => {
    const c = new DomainClassifier([FINANCE], embedder([0.9, 0.43, 0]), { threshold: 0.99 });
    const out = await c.classify('borderline');
    expect(out.domain).toBe('unclassified');
  });
});

describe('DomainClassifier — D.0 registry seam', () => {
  const stubRegistry = {
    has: (slug: string) => slug === 'fintech',
    get: () => undefined,
    require: () => { throw new Error('no'); },
    list: () => [],
    listByMaturity: () => [],
  };

  it('accepts ontology entries whose slugs are in the registry', () => {
    const ok = { ...FINANCE, domain: 'fintech' };
    expect(() => new DomainClassifier([ok], embedder([1, 0, 0]), { registry: stubRegistry })).not.toThrow();
  });

  it('rejects ontology entries whose slugs are not in the registry', () => {
    expect(
      () => new DomainClassifier([FINANCE], embedder([1, 0, 0]), { registry: stubRegistry }),
    ).toThrow(/not in the canonical domain registry/);
  });

  it('without a registry, ad-hoc slugs are accepted (pre-D.0 behavior)', () => {
    expect(() => new DomainClassifier([FINANCE], embedder([1, 0, 0]))).not.toThrow();
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });
  it('returns 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it('handles non-unit vectors', () => {
    expect(cosineSimilarity([2, 0], [3, 0])).toBeCloseTo(1, 5);
  });
});
