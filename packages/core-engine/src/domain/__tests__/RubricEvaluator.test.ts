/**
 * D.2 — RubricEvaluator + score math tests.
 */
import type {
  CriterionResult,
  DomainRubric,
  ICriterionCheckExecutor,
  RubricCriterion,
} from '@oweibo/core-contracts';
import {
  RubricEvaluator,
  computeJointScore,
  computeRubricScore,
} from '../RubricEvaluator.js';

const crit = (
  id: string,
  weight: number,
  failureBlocks = false,
  passed = true,
): RubricCriterion => ({
  criterionId: id,
  description: id,
  check: 'deterministic',
  checkConfig: { fn: 'stub', _passed: passed },
  weight,
  failureBlocks,
});

const stubRubric = (id: string, rubricWeight: number, criteria: RubricCriterion[]): DomainRubric => ({
  domainSlug: 'fintech',
  rubricId: id,
  title: id,
  description: '',
  appliesToTaskKinds: ['code_change'],
  weight: rubricWeight,
  version: '1.0',
  criteria,
});

const stubExecutor = (resultByCriterion: Record<string, Partial<CriterionResult>>): ICriterionCheckExecutor => ({
  async execute({ criterion }) {
    const override = resultByCriterion[criterion.criterionId] ?? {};
    const passed = override.passed ?? Boolean((criterion.checkConfig as { _passed?: boolean })._passed);
    return {
      criterionId: criterion.criterionId,
      score: override.score ?? (passed ? 1 : 0),
      passed,
      ...(override.skipped ? { skipped: true, skipReason: override.skipReason } : {}),
    };
  },
});

describe('computeRubricScore', () => {
  it('weighted mean over passing criteria', () => {
    const criteria = [crit('a', 0.5, false, true), crit('b', 0.5, false, false)];
    const results: CriterionResult[] = [
      { criterionId: 'a', score: 1, passed: true },
      { criterionId: 'b', score: 0, passed: false },
    ];
    expect(computeRubricScore(criteria, results)).toBeCloseTo(0.5, 5);
  });

  it('skipped criteria drop out of normalization', () => {
    const criteria = [crit('a', 0.5), crit('b', 0.5)];
    const results: CriterionResult[] = [
      { criterionId: 'a', score: 1, passed: true },
      { criterionId: 'b', score: 0, passed: false, skipped: true, skipReason: 'pending' },
    ];
    // Only a contributes; a passed so the rubric score is 1.0 (not 0.5).
    expect(computeRubricScore(criteria, results)).toBe(1);
  });

  it('returns 0 when every criterion is skipped', () => {
    const criteria = [crit('a', 0.5), crit('b', 0.5)];
    const results: CriterionResult[] = [
      { criterionId: 'a', score: 0, passed: false, skipped: true },
      { criterionId: 'b', score: 0, passed: false, skipped: true },
    ];
    expect(computeRubricScore(criteria, results)).toBe(0);
  });
});

describe('computeJointScore', () => {
  it('weight-normalises generic + per-rubric contributions to [0,1]', () => {
    const rubrics = [stubRubric('r1', 0.6, [crit('a', 1)])];
    const perRubric = [
      {
        rubricId: 'r1',
        domainSlug: 'fintech',
        rubricVersion: '1.0',
        score: 0.5,
        blocked: false,
        criterionResults: [{ criterionId: 'a', score: 0.5, passed: true }],
      },
    ];
    // generic 1.0 × (0.4/1.0) + 0.5 × (0.6/1.0) = 0.4 + 0.3 = 0.7
    expect(computeJointScore(perRubric, rubrics, { score: 1, weight: 0.4 })).toBeCloseTo(0.7, 5);
  });

  it('drops rubrics whose criteria were all skipped from both numerator and denominator', () => {
    const rubrics = [stubRubric('r1', 0.6, [crit('a', 1)])];
    const perRubric = [
      {
        rubricId: 'r1',
        domainSlug: 'fintech',
        rubricVersion: '1.0',
        score: 0,
        blocked: false,
        criterionResults: [{ criterionId: 'a', score: 0, passed: false, skipped: true }],
      },
    ];
    // Only generic contributes ⇒ joint == generic.
    expect(computeJointScore(perRubric, rubrics, { score: 0.9, weight: 0.4 })).toBeCloseTo(0.9, 5);
  });
});

describe('RubricEvaluator', () => {
  it('runs all rubrics, computes per-rubric and joint scores, sets blocked', async () => {
    const rubrics = [
      stubRubric('r1', 0.6, [crit('c1', 1.0, true /* failureBlocks */, false /* will fail */)]),
    ];
    const evaluator = new RubricEvaluator(stubExecutor({}));
    const out = await evaluator.evaluate({
      context: { tenantId: 't', taskId: 'task-1', taskKind: 'code_change' },
      rubrics,
      generic: { score: 1, weight: 0.4 },
    });
    expect(out.perRubric).toHaveLength(1);
    expect(out.perRubric[0]!.score).toBe(0);
    expect(out.perRubric[0]!.blocked).toBe(true);
    expect(out.blocked).toBe(true);
    // joint = generic 1 × 0.4 + rubric 0 × 0.6 = 0.4
    expect(out.jointScore).toBeCloseTo(0.4, 5);
  });

  it('does not set blocked when a failureBlocks criterion is skipped (cannot judge)', async () => {
    const rubrics = [stubRubric('r1', 0.6, [crit('c1', 1.0, true, false)])];
    const evaluator = new RubricEvaluator(
      stubExecutor({ c1: { skipped: true, skipReason: 'no_haystack' } }),
    );
    const out = await evaluator.evaluate({
      context: { tenantId: 't', taskId: 'task-1', taskKind: 'code_change' },
      rubrics,
      generic: { score: 1, weight: 0.4 },
    });
    expect(out.blocked).toBe(false);
  });

  it('isolates executor exceptions as skipped criteria rather than throwing', async () => {
    const throwing: ICriterionCheckExecutor = {
      async execute() { throw new Error('boom'); },
    };
    const rubrics = [stubRubric('r1', 0.5, [crit('c1', 1)])];
    const evaluator = new RubricEvaluator(throwing);
    const out = await evaluator.evaluate({
      context: { tenantId: 't', taskId: 'task-1', taskKind: 'code_change' },
      rubrics,
    });
    expect(out.perRubric[0]!.criterionResults[0]!.skipped).toBe(true);
    expect(out.perRubric[0]!.criterionResults[0]!.skipReason).toMatch(/executor_error/);
  });
});
