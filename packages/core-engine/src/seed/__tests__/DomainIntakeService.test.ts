/**
 * T.2.g — DomainIntakeService tests.
 */
import { DomainIntakeService, renderIntakeText } from '../DomainIntakeService.js';
import { DomainClassifier, type DomainOntologyEntry } from '../DomainClassifier.js';

const FINANCE: DomainOntologyEntry = {
  domain: 'finance',
  displayName: 'Finance',
  embedding: [1, 0, 0],
  recommendedTemplate: 'fintech-smb',
  recommendedConnectors: ['stripe', 'plaid'],
};

describe('renderIntakeText', () => {
  it('renders Q+A pairs', () => {
    const text = renderIntakeText({
      interviewAnswers: [{ question: 'industry?', answer: 'finance' }],
    });
    expect(text).toContain('Q: industry?');
    expect(text).toContain('A: finance');
  });

  it('appends primer excerpts + repo signals', () => {
    const text = renderIntakeText({
      primerExcerpts: ['internal wiki text'],
      repoSignals: { languages: ['typescript'], frameworks: ['nextjs'] },
    });
    expect(text).toContain('internal wiki text');
    expect(text).toContain('Languages: typescript');
    expect(text).toContain('Frameworks: nextjs');
  });

  it('returns empty string for an empty input', () => {
    expect(renderIntakeText({})).toBe('');
  });
});

describe('DomainIntakeService.classifyAndRecommend', () => {
  it('returns the classification + per-domain seed skills', async () => {
    const classifier = new DomainClassifier([FINANCE], async () => [1, 0, 0]);
    const svc = new DomainIntakeService(classifier);
    const r = await svc.classifyAndRecommend({
      interviewAnswers: [{ question: 'industry?', answer: 'finance' }],
    });
    expect(r.classification.domain).toBe('finance');
    expect(r.recommendedSeedSkills).toEqual(
      expect.arrayContaining(['code-review-pass']),
    );
  });

  it('returns an empty seed-skill list when unclassified', async () => {
    const classifier = new DomainClassifier([FINANCE], async () => [0, 1, 0], { threshold: 0.7 });
    const svc = new DomainIntakeService(classifier);
    const r = await svc.classifyAndRecommend({
      interviewAnswers: [{ question: 'industry?', answer: 'something obscure' }],
    });
    expect(r.classification.domain).toBe('unclassified');
    expect(r.recommendedSeedSkills).toEqual([]);
  });
});
