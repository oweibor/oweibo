/**
 * S.3 (ttv-action-safety-v2): rollback adapter contract.
 *
 * T.−1 captures `RollbackEnvelope` at proposal time. S.3 makes rollback
 * runnable: each connector / integration ships an `IRollbackAdapter` that
 * knows how to *execute* the rollback. The orchestrator resolves the
 * adapter from a registry (keyed by adapter name) and invokes
 * preflight + execute under a per-adapter timeout.
 *
 * Adapters MUST be idempotent — double-executing must produce the same
 * end-state. The orchestrator may retry, and operators may invoke
 * rollback manually after auto-rollback already ran.
 */
import type { RollbackEnvelope } from './IActionGate.js';

export type RollbackInvokerType = 'agent' | 'human' | 'auto_drift_detection';

export interface RollbackContext {
  readonly tenantId: string;
  readonly originalActionId: string;
  /** Plan id when the original action was part of an ActionPlan; null otherwise. */
  readonly originalPlanId: string | null;
  readonly invokedBy: { readonly type: RollbackInvokerType; readonly id: string };
  /** Stable id for log correlation across orchestrator + adapter logs. */
  readonly correlationId: string;
}

export type RollbackResultState =
  | 'fully_reverted'
  | 'partial'
  | 'no_op_already_reverted'
  | 'failed';

export interface RollbackResult {
  readonly success: boolean;
  readonly state: RollbackResultState;
  readonly details: string;
  /** Side-effects observed during rollback (e.g. notifications fired). */
  readonly sideEffects: readonly string[];
  /** Estimated USD-cents cost incurred by the rollback itself. */
  readonly costUsdCents: number;
}

export interface IRollbackAdapter {
  /** Stable name used by orchestrator to look this adapter up. */
  readonly name: string;
  /**
   * Verify the rollback can be performed against current state. Called
   * before `execute()`. THROW on impossibility — the orchestrator will
   * surface the error to the operator without writing a failed execution.
   */
  preflight(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<void>;
  /**
   * Execute the rollback. Idempotent: calling twice yields the same
   * end-state. Returns `state='no_op_already_reverted'` when the second
   * call finds the system already in the desired state.
   */
  execute(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<RollbackResult>;
}
