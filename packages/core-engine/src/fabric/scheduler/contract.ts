/**
 * ADR-013 scheduler contract predicates.
 *
 * These are the *contract*, not the machinery: pure, dependency-free
 * expressions of two Normative-Core invariants, shipped and verified green at
 * ADR-013 ratification. The scheduler machinery that consumes them (JobQueue,
 * WorkerLease, sweeper, admission) is built at K.0.
 *
 *   - isFencingTokenStale  → INV-8 (exclusive operations write only under a
 *                            valid fencing token)
 *   - selectShedClass      → INV-9 (class-1 is never shed or starved)
 *
 * Keeping them here, isolated from I/O, lets the K.0 write path and the K.0
 * shedding admission both import the single source of truth rather than
 * re-implementing the rule.
 */

/** Priority classes (ADR-013 §3.3). Lower number = higher priority. */
export type JobClass = 1 | 2 | 3 | 4 | 5;

/** The one class that is never shed and never starved (INV-9). */
export const NEVER_SHED_CLASS: JobClass = 1;

/**
 * INV-8 fencing predicate. A write presented under an exclusive lease is stale
 * — and MUST be rejected — when its token is below the target's last-seen
 * high-water token. A worker whose lease expired and was re-acquired by another
 * holder carries a strictly lower token and is caught here.
 *
 * Equal tokens are NOT stale: the current holder re-presenting its own token is
 * valid (idempotent retry within the same lease).
 */
export function isFencingTokenStale(presented: bigint, current: bigint): boolean {
  return presented < current;
}

/**
 * INV-9 shedding selector. Given queued depth per class, returns the class to
 * shed first — the highest-numbered (lowest-priority) class with work — or
 * `null` when only class 1 has work (nothing may be shed). By construction this
 * function can NEVER return class 1.
 */
export function selectShedClass(depths: Readonly<Record<JobClass, number>>): JobClass | null {
  // Walk from lowest priority (5) up to — but excluding — class 1.
  for (let c = 5; c > NEVER_SHED_CLASS; c--) {
    if ((depths[c as JobClass] ?? 0) > 0) {
      return c as JobClass;
    }
  }
  return null;
}
