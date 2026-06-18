/**
 * T.2.d: IGoalTemplateMatcher — the GoalDecomposer's pre-LLM hook.
 *
 * Before invoking the LLM, GoalDecomposer asks the matcher for the best
 * template whose triggerSummary embedding is similar to the input goal.
 * If similarity >= threshold (default 0.78), the template's
 * sub-goal skeleton is used as a seed for the LLM rather than expecting
 * the LLM to start from scratch. Below threshold, the matcher returns
 * null and the original LLM path runs unchanged.
 */
import type { ISubGoal } from '../types/Plan.js';

export interface GoalTemplateMatch {
  /** Stable id of the template that matched. */
  readonly templateId: string;
  /** Catalog version at match time — pins the skeleton against future bumps. */
  readonly catalogVersion: string;
  /** 0..1 cosine similarity (or equivalent) — useful for telemetry. */
  readonly similarity: number;
  /** The pre-baked sub-goal skeleton the decomposer should seed with. */
  readonly subGoalSkeleton: readonly ISubGoal[];
}

export interface IGoalTemplateMatcher {
  /**
   * Return the best matching template for `goalDescription`, or null when no
   * template clears the configured similarity threshold. Implementations
   * MUST be deterministic for the same input + catalog state so the LLM
   * trace is reproducible.
   */
  match(goalDescription: string): Promise<GoalTemplateMatch | null>;
}
