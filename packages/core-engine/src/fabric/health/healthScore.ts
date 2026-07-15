/**
 * K.9 / arch §23 — connector health score (0–100) and its two consumers.
 *
 * §23 gives the health score TWO consumers, and the second is the load-bearing
 * one: tenant admins (dashboards/alerts) AND the Query Planner, which uses a
 * degrading score to bias fan-out toward the index path "BEFORE the state
 * machine ever transitions to Degraded". That planner-facing use is a
 * cross-subsystem contract the architecture owns (ADR-009 deferred defining it
 * to here) — so this module implements §23's text; it does not invent a new
 * contract.
 *
 * The score is composed from the seven §23 inputs, each normalized to [0,1]
 * where 1 is healthy, then weighted. It is deliberately a PURE function of a
 * metrics snapshot: health is an observation, never a decision, so it takes no
 * planner and no lifecycle machine.
 */

/** The seven §23 health inputs, each already normalized to [0,1] (1 = healthy). */
export interface HealthInputs {
  /** Authentication state: 1 authenticated, 0 auth failure. */
  readonly auth: number;
  /** Sync lag vs freshness target: 1 within target, →0 as lag grows. */
  readonly syncFreshness: number;
  /** Job success rate (§4.7): 1 all succeed, 0 all fail. */
  readonly jobSuccess: number;
  /** Quota headroom: 1 ample, 0 exhausted. */
  readonly quotaHeadroom: number;
  /** Live-call latency vs SLA: 1 fast, →0 as latency approaches the SLA ceiling. */
  readonly liveLatency: number;
  /** ACL refresh success: 1 refreshing, 0 refresh failing. */
  readonly aclRefresh: number;
  /** Index coverage: fraction of discovered docs successfully indexed. */
  readonly indexCoverage: number;
}

/**
 * §23 weights. Expected to evolve (operational defaults) — the SELECTION of
 * inputs is architectural, the weights are tunable. Auth and ACL-refresh carry
 * the most weight: they are permission-correctness signals, and a connector that
 * cannot authenticate or refresh ACLs is dangerous, not merely slow.
 */
export const HEALTH_WEIGHTS: Readonly<Record<keyof HealthInputs, number>> = {
  auth: 0.25,
  aclRefresh: 0.20,
  syncFreshness: 0.15,
  jobSuccess: 0.15,
  indexCoverage: 0.10,
  liveLatency: 0.10,
  quotaHeadroom: 0.05,
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Compute the 0–100 composite health score from a metrics snapshot. */
export function healthScore(inputs: HealthInputs): number {
  let sum = 0;
  for (const k of Object.keys(HEALTH_WEIGHTS) as (keyof HealthInputs)[]) {
    sum += HEALTH_WEIGHTS[k] * clamp01(inputs[k]);
  }
  return Math.round(sum * 100);
}

/**
 * §23 planner-facing consumer: below this score the planner biases fan-out
 * toward the index path (cheaper, no live round-trip) even though the connector
 * is still nominally serving. This fires BEFORE the ADR-004 lifecycle machine
 * reaches Degraded — an early, graduated response to a declining connector.
 *
 * Operational default; tunable without reopening (the MECHANISM — a score
 * threshold biasing path selection — is the §23 contract).
 */
export const PLANNER_INDEX_BIAS_THRESHOLD = 60;

export type LivePathBias = 'prefer_live' | 'prefer_index';

/**
 * The planner's live-vs-index bias for a connector given its current health.
 * This is the ONE cross-subsystem output (§23): a degrading score biases the
 * plan, it does NOT withhold (withholding is ADR-004 Degraded + ADR-010's
 * decideServing — a stricter, later mechanism). Health biases; lifecycle gates.
 */
export function livePathBias(score: number): LivePathBias {
  return score < PLANNER_INDEX_BIAS_THRESHOLD ? 'prefer_index' : 'prefer_live';
}
