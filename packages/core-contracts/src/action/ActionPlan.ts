/**
 * S.0: ActionPlan — a sequence of actions with shared approval state.
 *
 * Single-action call sites construct a one-action plan implicitly so the
 * upstream API surface stays backwards-compatible with the per-action
 * gate from ttv.md T.−1. The plan-level gate (`ActionPlanGate.gatePlan`)
 * is the only entry point that consults plan budget, atomicity, and the
 * cross-action approval semantics.
 */
import type { ActionClass } from './ActionClass.js';
import type { RollbackEnvelope } from './IActionGate.js';
import type { BlastRadius, BlastRadiusContribution } from './BlastRadius.js';

export type PlanAtomicity =
  /** Any action failure ⇒ rollback all completed actions. */
  | 'all_or_nothing'
  /** Failures reported but don't trigger rollback; siblings still run. */
  | 'best_effort'
  /** Stop on first failure; completed steps stay (no rollback). */
  | 'sequential_with_checkpoints';

export type PlanState =
  | 'pending'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'aborted';

export interface PlannedAction {
  /** 1-based ordinal within the plan. Used by `dependsOn`. */
  readonly stepNumber: number;
  readonly actionClass: ActionClass;
  readonly summary: string;
  readonly payload: unknown;
  /** Step numbers this action depends on. Must form a DAG over [1..N]. */
  readonly dependsOn?: readonly number[];
  readonly rollback?: RollbackEnvelope;
  readonly blastRadiusContribution: BlastRadiusContribution;
}

export interface ActionPlan {
  readonly planId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly originatingTaskId: string;
  /** Human-readable; surfaced in plan-approval UI. */
  readonly title: string;
  readonly actions: readonly PlannedAction[];
  readonly blastRadius: BlastRadius;
  readonly atomicity: PlanAtomicity;
  readonly createdAt: string;
}

/**
 * Decision returned by `ActionPlanGate.gatePlan()`. Three terminal modes:
 *   - `execute_each` — plan structure is OK; each action will be re-gated
 *     individually at execution time (today's T.−1 semantics).
 *   - `require_approval_for_plan` — one approval at the plan level covers
 *     every member action. A single proposal row is written with
 *     `step_number = NULL`.
 *   - `forbidden` — at least one action's class is hard-pinned forbidden.
 */
export type PlanGateMode = 'execute_each' | 'require_approval_for_plan' | 'forbidden';

export interface PlanGateDecision {
  readonly mode: PlanGateMode;
  /** Set when mode === 'require_approval_for_plan'. */
  readonly planProposalId?: string;
  /** Set when mode === 'forbidden'. */
  readonly reason?: string;
  /** Aggregated blast-radius as computed at gate time. */
  readonly blastRadius: BlastRadius;
}
