/**
 * S.5.a (ttv-action-safety-v2): pre-execution content inspection contract.
 *
 * A `ContentInspector` examines an action's payload BEFORE execution and
 * returns one of three verdicts:
 *
 *   * `allow`               — payload is fine; pass through to the gate
 *   * `upgrade_to_approval` — payload is suspicious; force require_approval
 *                             even if the trust state would otherwise
 *                             return execute or dry_run
 *   * `forbid`              — payload is bad enough to block outright
 *
 * Inspectors MAY ONLY upgrade restrictions — never downgrade. A class
 * whose default mode is require_approval cannot be relaxed to execute
 * by an inspector. The trust ladder enforces this in the combine step.
 *
 * Inspectors are pure functions of (payload, context); they MUST NOT
 * have side effects. Any audit record is the responsibility of the
 * trust ladder which records the verdict into content_inspection_results
 * AFTER receiving the verdict.
 */
import type { ActionContext } from './IActionGate.js';

export type ContentVerdict = 'allow' | 'upgrade_to_approval' | 'forbid';

export interface ContentInspectionResult {
  readonly verdict: ContentVerdict;
  /** Short human-readable reason; surfaced to operator UI. */
  readonly reason?: string;
  /** Inspector-specific structured detail; persisted for audit. */
  readonly details?: unknown;
}

export interface IContentInspector {
  /** Stable identifier used in registry lookup and audit rows. */
  readonly name: string;
  /**
   * Returns true when this inspector should run for the given action
   * class. Cheap predicate; called on every gate(). Inspectors that
   * apply to many classes (e.g. GenericPiiInspector) return true broadly;
   * narrow inspectors (e.g. SqlContentInspector) return true only for
   * their slice.
   */
  appliesTo(actionClass: string): boolean;
  /**
   * Inspect the action's payload. MUST be pure and synchronous; if an
   * inspector needs I/O (e.g. a remote DLP API call) wrap it in a
   * Promise here, but the trust ladder applies a short timeout.
   */
  inspect(ctx: ActionContext): Promise<ContentInspectionResult>;
}

/**
 * Combine multiple inspector verdicts into a single decision. Pure
 * helper exported so tests can verify the combine semantics.
 */
export function combineVerdicts(
  verdicts: readonly ContentInspectionResult[],
): ContentInspectionResult {
  if (verdicts.length === 0) return { verdict: 'allow' };
  // Worst-of: forbid > upgrade_to_approval > allow.
  let worst: ContentInspectionResult = { verdict: 'allow' };
  for (const v of verdicts) {
    if (v.verdict === 'forbid') return v;
    if (v.verdict === 'upgrade_to_approval' && worst.verdict !== 'upgrade_to_approval') {
      worst = v;
    }
  }
  return worst;
}
