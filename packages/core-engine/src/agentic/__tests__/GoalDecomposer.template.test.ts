/**
 * T.2.d — GoalDecomposer with optional pre-LLM template matcher.
 * Verifies that:
 *   - without a matcher, behavior is byte-identical to the pre-T.2.d path
 *   - with a matching template, the LLM prompt includes the skeleton hint
 *   - matcher exceptions are absorbed (decomposition continues without hint)
 *   - if the LLM produces unparseable output and a template matched, the
 *     skeleton becomes the fallback (instead of the generic single-step plan)
 */
import { GoalDecomposer } from '../GoalDecomposer.js';
import type { ILLMClient, IGoalTemplateMatcher } from '@oweibo/core-contracts';

function makeLLM(output: string): ILLMClient {
  return {
    generate: jest.fn().mockResolvedValue({ output }),
  } as unknown as ILLMClient;
}

const VALID_PLAN = JSON.stringify([
  { description: 'a' },
  { description: 'b', dependsOn: ['a'] },
]);

describe('GoalDecomposer without matcher', () => {
  it('runs the original LLM-only path', async () => {
    const llm = makeLLM(VALID_PLAN);
    const decomposer = new GoalDecomposer(llm);
    const out = await decomposer.decompose({ description: 'add an endpoint' });
    expect(out).toHaveLength(2);
    expect(out[0]?.description).toBe('a');
  });
});

describe('GoalDecomposer with matcher', () => {
  it('adds a skeleton hint to the LLM prompt when a template matches', async () => {
    const llm = makeLLM(VALID_PLAN);
    const matcher: IGoalTemplateMatcher = {
      match: jest.fn().mockResolvedValue({
        templateId: 'feature.add-rest-endpoint',
        catalogVersion: '1',
        similarity: 0.92,
        subGoalSkeleton: [{ description: 'define route' }],
      }),
    };
    const decomposer = new GoalDecomposer(llm, { templateMatcher: matcher });
    await decomposer.decompose({ description: 'add endpoint' });

    expect((llm.generate as jest.Mock).mock.calls).toHaveLength(1);
    const args = (llm.generate as jest.Mock).mock.calls[0]?.[0] as { userPrompt: string };
    expect(args.userPrompt).toContain('feature.add-rest-endpoint');
    expect(args.userPrompt).toContain('define route');
  });

  it('omits the hint and proceeds when no template clears the threshold', async () => {
    const llm = makeLLM(VALID_PLAN);
    const matcher: IGoalTemplateMatcher = { match: jest.fn().mockResolvedValue(null) };
    const decomposer = new GoalDecomposer(llm, { templateMatcher: matcher });
    await decomposer.decompose({ description: 'unusual goal nothing matches' });
    const args = (llm.generate as jest.Mock).mock.calls[0]?.[0] as { userPrompt: string };
    expect(args.userPrompt).not.toContain('Pre-baked skeleton');
  });

  it('absorbs matcher exceptions and continues with the LLM path', async () => {
    const llm = makeLLM(VALID_PLAN);
    const matcher: IGoalTemplateMatcher = {
      match: jest.fn().mockRejectedValue(new Error('embed service down')),
    };
    const decomposer = new GoalDecomposer(llm, { templateMatcher: matcher });
    const out = await decomposer.decompose({ description: 'add endpoint' });
    expect(out).toHaveLength(2);
  });

  it('falls back to the template skeleton when LLM output is unparseable AND a template matched', async () => {
    const llm = makeLLM('not json');
    const skeleton = [
      { description: 'define route' },
      { description: 'add handler', dependsOn: ['define route'] },
    ];
    const matcher: IGoalTemplateMatcher = {
      match: jest.fn().mockResolvedValue({
        templateId: 'feature.add-rest-endpoint',
        catalogVersion: '1',
        similarity: 0.9,
        subGoalSkeleton: skeleton,
      }),
    };
    const decomposer = new GoalDecomposer(llm, { templateMatcher: matcher });
    const out = await decomposer.decompose({ description: 'add endpoint' });
    expect(out.map((s) => s.description)).toEqual(['define route', 'add handler']);
  });

  it('falls back to the single-step generic plan when LLM output is unparseable AND no template matched', async () => {
    const llm = makeLLM('not json');
    const matcher: IGoalTemplateMatcher = { match: jest.fn().mockResolvedValue(null) };
    const decomposer = new GoalDecomposer(llm, { templateMatcher: matcher });
    const out = await decomposer.decompose({ description: 'one-off goal' });
    expect(out).toHaveLength(1);
    expect(out[0]?.description).toBe('one-off goal');
  });
});
