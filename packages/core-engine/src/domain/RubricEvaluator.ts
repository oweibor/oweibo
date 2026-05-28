/**
 * D.2 (domain-depth): RubricEvaluator — runs criteria, computes per-
 * rubric and joint scores, surfaces the `blocked` flag.
 *
 * Math (per ttv-domain-depth.md §D.2 Joint score):
 *
 *   per_rubric_score(r) = Σ ( crit_score(c) × c.normalized_weight  for c in r.criteria )
 *
 *   W = generic_weight + Σ ( r.weight  for r in applicable_rubrics )
 *   joint_score =
 *       ( generic_score × (generic_weight / W) )
 *     + Σ ( per_rubric_score(r) × (r.weight / W)  for r in applicable_rubrics )
 *
 *   blocked = any( c.failureBlocks && !c.passed  for c in any rubric's criteria )
 *
 * Skipped criteria (executor returned `skipped:true`) are excluded from
 * weight normalisation — a deferred-to-SME criterion neither lifts nor
 * depresses the rubric score, it just doesn't contribute. A rubric with
 * every criterion skipped contributes `score = 0` and `weight = 0` to
 * the joint score (i.e., it drops out of the denominator too).
 */
import type {
  CriterionResult,
  DomainRubric,
  ICriterionCheckExecutor,
  RubricCriterion,
  RubricEvaluationContext,
  RubricEvaluationResult,
  TaskRubricEvaluation,
} from '@oweibo/core-contracts';

export interface GenericRubricInput {
  /**
   * Pre-computed generic score in [0,1] (compile + tests pass + output
   * non-empty + …). The evaluator does not run generic checks itself —
   * the eval pipeline owns that surface and supplies the result.
   */
  readonly score: number;
  /** Weight to give generic rubrics in the joint score. Default: 0.4. */
  readonly weight: number;
}

export interface RubricEvaluatorOptions {
  /** Default 0.4 — matches the typical fintech audit-trail rubric weight. */
  genericWeightDefault?: number;
  /** Clock for evaluatedAt timestamps. Defaults to () => new Date(). */
  now?: () => Date;
}

export class RubricEvaluator {
  private readonly genericWeightDefault: number;
  private readonly now: () => Date;

  constructor(
    private readonly executor: ICriterionCheckExecutor,
    opts: RubricEvaluatorOptions = {},
  ) {
    this.genericWeightDefault = opts.genericWeightDefault ?? 0.4;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Evaluate the supplied rubrics against the task context. The caller
   * supplies the generic-rubric score directly (the evaluator does not
   * run generic checks). Returns a TaskRubricEvaluation with per-rubric
   * results, joint score, and the global blocked flag.
   */
  async evaluate(input: {
    context: RubricEvaluationContext;
    rubrics: readonly DomainRubric[];
    generic?: GenericRubricInput;
  }): Promise<TaskRubricEvaluation> {
    const generic = input.generic ?? { score: 1.0, weight: this.genericWeightDefault };

    const perRubric: RubricEvaluationResult[] = [];
    for (const rubric of input.rubrics) {
      const r = await this.evaluateOne(rubric, input.context);
      perRubric.push(r);
    }

    const jointScore = computeJointScore(perRubric, input.rubrics, generic);
    const blocked = perRubric.some((r) => r.blocked);

    return {
      tenantId: input.context.tenantId,
      taskId: input.context.taskId,
      taskKind: input.context.taskKind,
      perRubric,
      jointScore,
      blocked,
      evaluatedAt: this.now().toISOString(),
    };
  }

  private async evaluateOne(
    rubric: DomainRubric,
    context: RubricEvaluationContext,
  ): Promise<RubricEvaluationResult> {
    const criterionResults: CriterionResult[] = [];
    let blocked = false;

    for (const criterion of rubric.criteria) {
      const result = await this.runCriterionSafely(criterion, context);
      criterionResults.push(result);
      if (!result.skipped && criterion.failureBlocks && !result.passed) {
        blocked = true;
      }
    }

    const score = computeRubricScore(rubric.criteria, criterionResults);
    return {
      rubricId: rubric.rubricId,
      domainSlug: rubric.domainSlug,
      rubricVersion: rubric.version,
      score,
      blocked,
      criterionResults,
    };
  }

  private async runCriterionSafely(
    criterion: RubricCriterion,
    context: RubricEvaluationContext,
  ): Promise<CriterionResult> {
    try {
      return await this.executor.execute({ criterion, context });
    } catch (err) {
      return {
        criterionId: criterion.criterionId,
        score: 0,
        passed: false,
        skipped: true,
        skipReason: err instanceof Error ? `executor_error: ${err.message}` : 'executor_error',
      };
    }
  }
}

// ─── Score math (pure) ───────────────────────────────────────────────────────

/**
 * Per-rubric score: weighted mean over non-skipped criteria. Criterion
 * weights are normalised within the non-skipped subset so adding a
 * skipped criterion does not depress the rubric score.
 */
export function computeRubricScore(
  criteria: readonly RubricCriterion[],
  results: readonly CriterionResult[],
): number {
  const byId = new Map(results.map((r) => [r.criterionId, r]));
  let weightedSum = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    const r = byId.get(c.criterionId);
    if (!r || r.skipped) continue;
    weightedSum += clamp01(r.score) * c.weight;
    totalWeight += c.weight;
  }
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

/**
 * Joint score across generic + per-rubric scores. Weights are
 * normalised so the result is in [0,1] iff every input is. A rubric
 * with zero non-skipped criteria contributes 0 weight and 0 score (it
 * drops out entirely).
 */
export function computeJointScore(
  perRubric: readonly RubricEvaluationResult[],
  rubrics: readonly DomainRubric[],
  generic: GenericRubricInput,
): number {
  // Build a parallel weight stream: rubric.weight if the rubric had any
  // non-skipped criteria, 0 otherwise. We detect "no contribution" via
  // an all-skipped criterionResults set — score is necessarily 0 in
  // that case and we exclude both from the denominator.
  const rubricById = new Map(rubrics.map((r) => [r.rubricId, r]));
  let weightedSum = clamp01(generic.score) * generic.weight;
  let totalWeight = generic.weight;
  for (const pr of perRubric) {
    const rubric = rubricById.get(pr.rubricId);
    if (!rubric) continue;
    const anyContributing = pr.criterionResults.some((c) => !c.skipped);
    if (!anyContributing) continue;
    weightedSum += clamp01(pr.score) * rubric.weight;
    totalWeight += rubric.weight;
  }
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
