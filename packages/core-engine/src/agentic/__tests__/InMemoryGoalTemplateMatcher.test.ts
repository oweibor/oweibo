/**
 * T.2.d — InMemoryGoalTemplateMatcher tests.
 */
import {
  InMemoryGoalTemplateMatcher,
  cosineSimilarity,
  type MatcherTemplateEntry,
  type QueryEmbedder,
} from '../InMemoryGoalTemplateMatcher.js';

const E_A: MatcherTemplateEntry = {
  templateId: 'a',
  catalogVersion: '1',
  triggerSummary: 'add a new REST endpoint',
  triggerEmbedding: [1, 0, 0],
  subGoalSkeleton: [{ description: 'define route' }],
};
const E_B: MatcherTemplateEntry = {
  templateId: 'b',
  catalogVersion: '1',
  triggerSummary: 'scaffold a CLI tool',
  triggerEmbedding: [0, 1, 0],
  subGoalSkeleton: [{ description: 'init project' }],
};

function embedder(v: readonly number[]): QueryEmbedder {
  return async () => v;
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });
  it('returns 0 for empty / mismatched dims', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
  });
  it('handles non-unit vectors via norm', () => {
    expect(cosineSimilarity([2, 0], [1, 0])).toBeCloseTo(1, 5);
  });
});

describe('InMemoryGoalTemplateMatcher', () => {
  it('returns null when catalog is empty', async () => {
    const m = new InMemoryGoalTemplateMatcher([], embedder([1, 0, 0]));
    expect(await m.match('anything')).toBeNull();
  });

  it('returns null when query embedding is empty', async () => {
    const m = new InMemoryGoalTemplateMatcher([E_A], embedder([]));
    expect(await m.match('anything')).toBeNull();
  });

  it('returns null when best similarity < threshold', async () => {
    const m = new InMemoryGoalTemplateMatcher([E_A, E_B], embedder([0, 0, 1]));
    expect(await m.match('anything')).toBeNull();
  });

  it('picks the entry with highest similarity above threshold', async () => {
    const m = new InMemoryGoalTemplateMatcher([E_A, E_B], embedder([1, 0, 0]), { threshold: 0.5 });
    const out = await m.match('add a new REST endpoint please');
    expect(out?.templateId).toBe('a');
    expect(out?.similarity).toBe(1);
  });

  it('skips entries whose embedding dim does not match the query', async () => {
    const wrongDim: MatcherTemplateEntry = { ...E_A, triggerEmbedding: [1, 0] };
    const m = new InMemoryGoalTemplateMatcher([wrongDim, E_B], embedder([0, 1, 0]), { threshold: 0.5 });
    const out = await m.match('build a CLI');
    expect(out?.templateId).toBe('b');
  });

  it('honors custom threshold above default 0.78', async () => {
    const m = new InMemoryGoalTemplateMatcher([E_A], embedder([0.9, 0.1, 0]), { threshold: 0.999 });
    expect(await m.match('anything')).toBeNull();
  });

  it('returns the catalog version + skeleton from the matched entry', async () => {
    const m = new InMemoryGoalTemplateMatcher([E_A], embedder([1, 0, 0]), { threshold: 0.5 });
    const out = await m.match('add endpoint');
    expect(out?.catalogVersion).toBe('1');
    expect(out?.subGoalSkeleton[0]?.description).toBe('define route');
  });
});
