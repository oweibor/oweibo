/**
 * D.2 (domain-depth): per-domain eval rubric contract.
 *
 * A rubric is a set of criteria evaluated against a completed task's
 * outputs. Generic rubrics (compile, tests pass, output non-empty) still
 * apply; domain rubrics are *added on top*. The joint score is a
 * weight-normalised mean over the applicable set — never strictly less
 * permissive than generic alone, per design principle 24
 * (ttv-domain-depth.md §2): "Existing platform-wide rules are a floor,
 * not a ceiling."
 *
 * Blocking and scoring are deliberately decoupled: a criterion with
 * `failureBlocks: true` marks the task as failed regardless of the
 * numeric score so dashboards can render "Failed (score N/A)" without
 * trying to reconcile the two signals.
 */
import type { DomainSlug } from './DomainSlug.js';

/** How a criterion is evaluated. */
export type RubricCheckKind = 'deterministic' | 'llm_judge' | 'sme_required';

export interface RubricCriterion {
  readonly criterionId: string;
  readonly description: string;
  readonly check: RubricCheckKind;
  /**
   * Free-form check config consumed by the matching executor:
   *   - deterministic: `{ fn: string, ...args }` for the built-in
   *     check library (`grepCheck`, `auditFieldPresent`, …).
   *   - llm_judge: `{ judgePrompt: string, ...modelHints }`.
   *   - sme_required: opaque; the SME review queue routes by criterion id.
   */
  readonly checkConfig: unknown;
  /** 0..1; criterion weights within a rubric are normalised at evaluation time. */
  readonly weight: number;
  /**
   * When true, this criterion failing marks the task as `failed`
   * regardless of the joint score. Independent of the score so a
   * blocked task still surfaces its numeric value for cross-rubric
   * analysis.
   */
  readonly failureBlocks: boolean;
}

export interface DomainRubric {
  readonly domainSlug: DomainSlug;
  /** Unique within domain. */
  readonly rubricId: string;
  readonly title: string;
  readonly description: string;
  /** Task kinds (e.g., 'code_change', 'database_migration') this rubric applies to. */
  readonly appliesToTaskKinds: readonly string[];
  readonly criteria: readonly RubricCriterion[];
  /** 0..1; rubric weights are normalised across the applicable set at evaluation time. */
  readonly weight: number;
  readonly version: string;
}

/**
 * The output of evaluating a single criterion. `score` is in [0,1].
 * `passed` is a convenience derived from `score >= passingThreshold`
 * (default 0.5); executors that have a clearer notion of pass/fail
 * set `passed` directly and provide `score=passed?1:0`.
 */
export interface CriterionResult {
  readonly criterionId: string;
  readonly score: number;
  readonly passed: boolean;
  readonly details?: unknown;
  /** When the executor cannot run the check (missing config, deferred to SME), reports the cause. */
  readonly skipped?: boolean;
  readonly skipReason?: string;
}

/**
 * The output of evaluating a single rubric: per-criterion results, the
 * rubric's score (weighted mean over the *non-skipped* criteria) and
 * the `blocked` flag (true iff any failureBlocks criterion failed and
 * was not skipped).
 */
export interface RubricEvaluationResult {
  readonly rubricId: string;
  readonly domainSlug?: DomainSlug;
  readonly rubricVersion: string;
  readonly score: number;
  readonly blocked: boolean;
  readonly criterionResults: readonly CriterionResult[];
}

/**
 * The output of evaluating a task against the full applicable rubric
 * set (generic + every domain rubric resolved for the tenant + task
 * kind). The joint score is a weight-normalised mean over the
 * `perRubric` array — see `RubricEvaluator` for the math.
 */
export interface TaskRubricEvaluation {
  readonly tenantId: string;
  readonly taskId: string;
  readonly taskKind: string;
  readonly perRubric: readonly RubricEvaluationResult[];
  /** Joint score in [0,1] across generic + applicable domain rubrics. */
  readonly jointScore: number;
  /** True iff any rubric was blocked. */
  readonly blocked: boolean;
  readonly evaluatedAt: string;
}

/**
 * Context passed to the evaluator. The shape is intentionally
 * minimal-and-extensible: executors may pull additional fixtures
 * (artifact bundle, audit log slice) from the context via
 * `executorContext`.
 */
export interface RubricEvaluationContext {
  readonly tenantId: string;
  readonly taskId: string;
  readonly taskKind: string;
  /**
   * Free-form bag of fixtures the executors need. Convention:
   *   { artifactBundle?, modifiedLines?, auditRow?, ... }
   */
  readonly executorContext?: Readonly<Record<string, unknown>>;
}

export interface IDomainRubricRegistry {
  /** All registered domain rubrics. */
  list(): readonly DomainRubric[];

  /** Rubrics for a specific domain. */
  forDomain(slug: DomainSlug): readonly DomainRubric[];

  /** Rubrics filtered by domain + applicable task kind. */
  forDomainAndTaskKind(slug: DomainSlug, taskKind: string): readonly DomainRubric[];
}

/**
 * Resolves the applicable rubric set for a task. The resolver consults
 * (a) the registry for domain rubrics, and (b) the tenant's bound
 * domain(s) via the supplied lookup. Generic rubrics (compile, tests,
 * non-empty) are owned by the caller and not modelled here.
 */
export interface IRubricResolver {
  resolve(input: { tenantId: string; taskKind: string }): Promise<readonly DomainRubric[]>;
}

/**
 * The check executor performs the actual criterion check. Implementations
 * route by `check` kind: deterministic to the built-in fn table; llm_judge
 * to the model client; sme_required defers to the review queue (returning
 * `skipped: true, skipReason: 'sme_review_pending'`).
 */
export interface ICriterionCheckExecutor {
  execute(input: {
    criterion: RubricCriterion;
    context: RubricEvaluationContext;
  }): Promise<CriterionResult>;
}
