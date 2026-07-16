/**
 * K.4 — Cost Estimator v0 (arch §7.1, §7.4). The planner OWNS the estimate
 * and the index-vs-live decision; the Governance Plane owns quota
 * enforcement and billing, the Observability Plane owns attribution (§7.4).
 * All three share the cost-event schema below so they never produce
 * conflicting figures.
 *
 * v0 posture (ADR-001 §3.5, Expected to evolve): the live path is not yet
 * executable (K.6), so the estimate is structural — a latency/call
 * prediction per candidate path against the deployment-profile budget. The
 * *method* is architectural; the numbers are operational defaults (§6).
 */

import type { FreshnessClass, RetrievalPath } from './contract.js';
import { QUOTA_EXHAUSTION_POLICY } from './contract.js';

/** The shared cost-event schema (§7.4) — one shape across the three planes. */
export interface CostEstimate {
  readonly path: RetrievalPath;
  readonly predictedLatencyMs: number;
  /** External (live MCP) source round-trips this path implies. */
  readonly predictedCalls: number;
  /** Within the deployment-profile latency budget? */
  readonly withinBudget: boolean;
}

/** Deployment-profile P95 index-path latency budgets (§23, initial defaults). */
export const INDEX_LATENCY_BUDGET_MS = { starter: 800, business: 500, enterprise: 250 } as const;
/** Live-path P95 budget, inclusive of source round-trip (§23). */
export const LIVE_LATENCY_BUDGET_MS = 3000;
/** Fan-out parallel cap (§7.6 default: top 3 ranked connectors). */
export const FANOUT_CAP = 3;

export type DeploymentProfile = keyof typeof INDEX_LATENCY_BUDGET_MS;

export interface CostInput {
  readonly path: RetrievalPath;
  readonly freshnessClass: FreshnessClass;
  /** Enabled connectors eligible for a live call on this query. */
  readonly liveConnectorCount: number;
  readonly profile?: DeploymentProfile;
}

/**
 * Estimate the cost of a candidate path. Index/graph paths cost no external
 * calls (served from the tenant index / graph store); live paths cost one
 * round-trip per fanned-out connector, capped at FANOUT_CAP (§7.6).
 */
export function estimateCost(input: CostInput): CostEstimate {
  const profile = input.profile ?? 'starter';
  if (input.path === 'live_mcp' || input.path === 'hybrid') {
    const calls = input.path === 'live_mcp' ? Math.min(input.liveConnectorCount, FANOUT_CAP) : 0;
    const predictedLatencyMs = input.path === 'live_mcp' ? LIVE_LATENCY_BUDGET_MS : INDEX_LATENCY_BUDGET_MS[profile];
    return { path: input.path, predictedLatencyMs, predictedCalls: calls, withinBudget: predictedLatencyMs <= LIVE_LATENCY_BUDGET_MS };
  }
  // index / graph / none — served locally.
  const predictedLatencyMs = INDEX_LATENCY_BUDGET_MS[profile];
  return { path: input.path, predictedLatencyMs, predictedCalls: 0, withinBudget: true };
}

/**
 * The index-vs-live decision (§7.5): when a live path is desired but its
 * quota is exhausted, the freshness class decides whether to fall back to
 * the index. Critical NEVER falls back (returns errorAndAlert); others do,
 * with escalating staleness tagging. Delegates to the exported §7.5 table
 * so "assumed a Critical query silently fell back" is a grep-able defect.
 */
export function resolveQuotaExhaustion(freshnessClass: FreshnessClass) {
  return QUOTA_EXHAUSTION_POLICY[freshnessClass];
}
