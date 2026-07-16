/**
 * ActionClassFloor — platform floor on how permissive an action class may be
 * made, and the single source of truth for it.
 *
 * A small set of high-risk action classes must ALWAYS keep a human in the
 * loop: they may resolve to `require_approval` (or stricter), but must never
 * be configured to run the live action (`execute`) unattended. This invariant
 * used to be enforced only on (a) the platform-default matrix and (b) the
 * gate's auto-promotion — NOT on the operator "pin" write path. That gap let
 * a tenant pin `financial.payment` (etc.) straight to `execute` via
 * POST /actions/trust-matrix/pin and bypass approval entirely. Centralising
 * the floor here lets both the gate (ActionTrustLadder) and the pin writer
 * (DryRunRegistry) enforce the same rule.
 *
 * The floor is extensible via ACTION_PIN_FLOOR_CLASSES (comma-separated action
 * classes). Extension can only ADD classes to the floor — never remove the
 * baseline — so operators can hold e.g. `write.tenant_db.prod` at approval too.
 */
import { type CoreActionClass } from '@oweibo/core-contracts';

export type PinMode = 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';

/** Baseline high-risk classes that must always require human approval. */
export const ALWAYS_REQUIRE_APPROVAL_CLASSES: ReadonlySet<CoreActionClass> = new Set<CoreActionClass>([
  'financial.payment',
  'personnel.access_grant',
  'personnel.access_revoke',
  'irreversible.delete_resource',
  'irreversible.public_publish',
]);

const EMPTY: ReadonlySet<string> = new Set();

/** Operator-configured additions to the floor (never removes the baseline). */
function envFloorExtension(): ReadonlySet<string> {
  const raw = process.env['ACTION_PIN_FLOOR_CLASSES'];
  if (!raw) return EMPTY;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** True when the action class is held at the require-approval floor. */
export function isFloorClass(actionClass: string): boolean {
  return ALWAYS_REQUIRE_APPROVAL_CLASSES.has(actionClass as CoreActionClass)
      || envFloorExtension().has(actionClass);
}

/**
 * A floor class may not be pinned to a mode that runs the live action without
 * approval. Only `execute` does that — `dry_run`/`shadow` never touch the live
 * system, and `require_approval`/`forbidden` are at or above the floor.
 */
export function pinViolatesFloor(actionClass: string, mode: PinMode): boolean {
  return isFloorClass(actionClass) && mode === 'execute';
}

/** Thrown by the pin writer when a pin would drop a floor class below approval. */
export class PinFloorViolationError extends Error {
  public readonly code = 'pin_below_action_class_floor' as const;
  constructor(
    public readonly actionClass: string,
    public readonly mode: string,
  ) {
    super(
      `pin_below_action_class_floor: '${actionClass}' is a high-risk class and ` +
      `may not be pinned to '${mode}' — it must stay at require_approval or stricter`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
