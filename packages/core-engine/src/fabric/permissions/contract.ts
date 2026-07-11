/**
 * ADR-010 contract predicates — the withholding state machine (§3.5) and
 * the staleness bounds, as pure functions.
 *
 * This is the *contract*, not the machinery: `decideServing` is the §6.6
 * per-class fork expressed as a testable predicate, shipped green at
 * ADR-010 ratification. The retrieval storage gate that CALLS it on every
 * result leaving the store is the K.3 deliverable; the live batteries
 * (two-user exclusion, revocation-within-bound, withhold-on-degrade) arm
 * there. Enforcement placement is normative: the predicate runs where
 * results leave the store, NEVER in the planner (INV-4 pattern).
 *
 * INV-3: Critical-class / compliance-flagged content is never served from
 * any cache and is withheld the moment its connector cannot verify a
 * permission decision live.
 */

export type FreshnessClass = 'static' | 'operational' | 'transactional' | 'critical';

/**
 * Connector serving state as the lifecycle (ADR-004) reports it:
 *  - healthy:      normal
 *  - degraded:     left Healthy (token expiry, lockout, network); the
 *                  withholding clock starts at this transition
 *  - revalidating: recovered, but the post-recovery live ACL
 *                  re-validation pass has not completed — Critical/
 *                  compliance stay withheld until it has (auto-lift)
 */
export type ConnectorServingState = 'healthy' | 'degraded' | 'revalidating';

export type ServingDecision =
  | 'serve'               // from index, untagged
  | 'serve_stale_tagged'  // from index with an explicit staleness tag
  | 'serve_tagged_logged' // tagged AND a degraded-serve event is logged (transactional row)
  | 'withhold';           // explicit "temporarily unavailable" — never silent omission

/**
 * ADR-010 §6 initial defaults (Expected to evolve — ops-tunable), per the
 * §5.2 bands. critical MUST stay 0 (Fixed): zero tolerance means the
 * withholding starts at the Degraded transition itself (Appendix A #4).
 */
export const DEFAULT_STALENESS_BOUNDS_MS: Readonly<Record<FreshnessClass, number>> = {
  static: 7 * 24 * 60 * 60 * 1000,
  operational: 15 * 60 * 1000,
  transactional: 60 * 1000,
  critical: 0,
};

/**
 * ADR-010 §3.2 / INV-9: membership delta syncs and the MembershipChanged
 * events they produce run in the scheduler's class-1 lane (never shed);
 * bootstrap crawls are class-2. Assignment is contract — the shed
 * predicate itself is ADR-013's.
 */
export const MEMBERSHIP_DELTA_JOB_CLASS = 1;
export const MEMBERSHIP_BOOTSTRAP_JOB_CLASS = 2;

export interface ServingDecisionInput {
  readonly freshnessClass: FreshnessClass;
  /** ADR-006-owned bit; this predicate only consumes it. Compliance-flagged
   *  content is treated exactly as critical (§6.4). */
  readonly complianceFlagged: boolean;
  readonly connectorState: ConnectorServingState;
  /** Epoch ms of the transition out of Healthy; required unless healthy. */
  readonly degradedSinceMs?: number;
  readonly nowMs: number;
  /** Override bounds (ops config); defaults to DEFAULT_STALENESS_BOUNDS_MS. */
  readonly boundsMs?: Readonly<Record<FreshnessClass, number>>;
}

/**
 * The §3.5 state machine as a pure decision. Given a connector's serving
 * state and how long it has been unable to verify permissions, decide how
 * content of a given class may be served.
 */
export function decideServing(input: ServingDecisionInput): ServingDecision {
  const bounds = input.boundsMs ?? DEFAULT_STALENESS_BOUNDS_MS;
  const criticalTier = input.complianceFlagged || input.freshnessClass === 'critical';

  if (input.connectorState === 'healthy') return 'serve';

  // revalidating: recovered but the live re-validation pass is incomplete.
  // Critical/compliance stay withheld (a permission decision is still
  // unverified for objects the pass hasn't reached); others serve tagged.
  if (input.connectorState === 'revalidating') {
    if (criticalTier) return 'withhold';
    return input.freshnessClass === 'static' ? 'serve' : 'serve_stale_tagged';
  }

  // degraded: fork by class once the outage exceeds the class bound.
  // critical's bound is 0 → withhold from the transition itself.
  if (criticalTier) return 'withhold';

  const degradedSince = input.degradedSinceMs;
  if (degradedSince === undefined) {
    // A degraded connector with no transition timestamp cannot prove the
    // outage is within any bound — fail toward the beyond-bound behavior
    // for the class rather than assume freshness.
    return beyondBound(input.freshnessClass);
  }
  const outageMs = input.nowMs - degradedSince;
  if (outageMs <= bounds[input.freshnessClass]) return 'serve';
  return beyondBound(input.freshnessClass);
}

function beyondBound(cls: Exclude<FreshnessClass, 'critical'>): ServingDecision {
  switch (cls) {
    case 'static': return 'serve';                 // index-only is the class's designed behavior
    case 'operational': return 'serve_stale_tagged';
    case 'transactional': return 'serve_tagged_logged';
  }
}

/**
 * §3.1 read-through gate: is a snapshot fresh enough to trust without a
 * synchronous live refresh? Critical/compliance never are (INV-3) — the
 * caller must go live regardless of snapshot age.
 */
export function snapshotWithinBound(input: {
  readonly freshnessClass: FreshnessClass;
  readonly complianceFlagged: boolean;
  readonly lastCheckedMs: number;
  readonly nowMs: number;
  readonly boundsMs?: Readonly<Record<FreshnessClass, number>>;
}): boolean {
  if (input.complianceFlagged || input.freshnessClass === 'critical') return false;
  const bounds = input.boundsMs ?? DEFAULT_STALENESS_BOUNDS_MS;
  return input.nowMs - input.lastCheckedMs <= bounds[input.freshnessClass];
}
