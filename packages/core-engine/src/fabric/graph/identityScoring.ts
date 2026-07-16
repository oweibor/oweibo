/**
 * ADR-002 contract predicates — identity resolution, as pure functions.
 * Confidence is the STRONGEST matching signal (never a sum); three states
 * gate a single auto-merge bar; a Provisional identity is always hedged.
 * Ships green at ADR-002 ratification; the K.8 IdentityResolutionService
 * builds on these.
 *
 * Identity feeds RANKING and the cache key and hedging — it is NEVER a
 * permission input (ACLs remain the sole authority).
 */

// ── §9.1 confidence scoring ──────────────────────────────────────────────
export type IdentitySignal =
  | 'employee_id'
  | 'corporate_email'
  | 'idp_principal_id'
  | 'oauth_subject'
  | 'name_and_manager'
  | 'name_only';

/** The §9.1 weight table verbatim (initial defaults; ADR-002 §6 Expected-to-evolve). */
export const IDENTITY_SIGNAL_WEIGHTS: Readonly<Record<IdentitySignal, number>> = {
  employee_id: 1.0,
  corporate_email: 0.98,
  idp_principal_id: 0.98,
  oauth_subject: 0.95,
  name_and_manager: 0.8,
  name_only: 0.3,
};

/**
 * Confidence = the MAXIMUM weight among matched signals (§3.2). Never a sum:
 * correlated evidence (corporate_email ∧ oauth_subject for the same SSO) must
 * not inflate confidence past the strongest independent signal. Empty → 0.
 */
export function scoreIdentity(signals: readonly IdentitySignal[]): number {
  let max = 0;
  for (const s of signals) {
    const w = IDENTITY_SIGNAL_WEIGHTS[s];
    if (w > max) max = w;
  }
  return max;
}

// ── §9.2 states ──────────────────────────────────────────────────────────
export type IdentityState = 'resolved' | 'provisional' | 'unresolved';

/**
 * §9.2 thresholds: >0.95 Resolved (auto-merge), 0.70–0.95 Provisional
 * (conservative + hedged), <0.70 Unresolved (independent).
 */
export function identityState(confidence: number): IdentityState {
  if (confidence > 0.95) return 'resolved';
  if (confidence >= 0.7) return 'provisional';
  return 'unresolved';
}

export type GraphExpansion = 'full' | 'conservative' | 'none';

/** Graph-expansion policy per state (§3.3). */
export function graphExpansion(state: IdentityState): GraphExpansion {
  return state === 'resolved' ? 'full' : state === 'provisional' ? 'conservative' : 'none';
}

/** True iff the state permits auto-merging the principal into the canonical identity. */
export function autoMerges(state: IdentityState): boolean {
  return state === 'resolved';
}

// ── §9.2/§3.4 hedged language ────────────────────────────────────────────
/**
 * The user-facing hedge contract (§3.4). A Resolved edge asserts directly; a
 * Provisional edge is ALWAYS hedged (the witness that the underlying edge is
 * `confidence: provisional`); an Unresolved edge is not expanded, so there is
 * no assertion to make (returns null).
 */
export function hedgeResponse(
  state: IdentityState,
  subject: string,
  relation: string,
  object: string,
): string | null {
  switch (state) {
    case 'resolved':
      return `${subject} ${relation} ${object}`;
    case 'provisional':
      return `Based on available identity mappings, ${subject} is likely ${relation} ${object}.`;
    case 'unresolved':
      return null;
  }
}
