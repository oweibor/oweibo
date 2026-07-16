/**
 * ADR-004 contract predicates — the connector lifecycle HSM, as pure
 * functions. Three independent regions composed into a tuple (never a flat
 * FSM); prohibited composites enforced at the transition (never inferred
 * after the fact); the frozen §11.7 failure taxonomy; and the projection of
 * the Auth region onto the ADR-010 serving state.
 *
 * ADR-004 is a TRIGGER for the storage-layer serving rule — it produces the
 * `ConnectorServingState` that ADR-010's `decideServing` consumes, and NEVER
 * decides serving posture itself. Ships green at ratification; K.6 arms
 * regions + Degraded/Throttled + withholding + resume; K.9 arms rotation +
 * upgrade rollout.
 */

import type { ConnectorServingState } from '../permissions/contract.js';

// ── Region states (§3.1) ────────────────────────────────────────────────
export type AuthState = 'healthy' | 'degraded' | 'rotating' | 'read_only' | 'disabled';
export type SyncState = 'idle' | 'syncing' | 'backlog' | 'throttled';
export type SchemaState = 'current' | 'migrating' | 'incompatible';

export interface ConnectorState {
  readonly auth: AuthState;
  readonly sync: SyncState;
  readonly schema: SchemaState;
}

export function composeState(auth: AuthState, sync: SyncState, schema: SchemaState): ConnectorState {
  return { auth, sync, schema };
}

/**
 * Project the Auth region onto the ADR-010 serving state (§3.1) — the ONLY
 * coupling from lifecycle to serving. `rotating` reports `revalidating`: a
 * recovering connector keeps Critical withheld until one revalidation pass
 * completes (§3.4).
 */
export function serviceState(auth: AuthState): ConnectorServingState {
  switch (auth) {
    case 'healthy': return 'healthy';
    case 'rotating': return 'revalidating';
    case 'degraded':
    case 'read_only':
    case 'disabled': return 'degraded';
  }
}

// ── Prohibited composites (§3.2) — enforced at the transition ────────────
export function isProhibitedComposite(state: ConnectorState): boolean {
  // Indexing against a mid-migration or incompatible schema corrupts chunks.
  if (state.schema === 'migrating' && (state.sync === 'syncing' || state.sync === 'backlog')) return true;
  if (state.schema === 'incompatible' && state.sync !== 'idle') return true;
  // A disabled connector performs no sync work.
  if (state.auth === 'disabled' && state.sync !== 'idle') return true;
  return false;
}

/**
 * Assert a transition into `to` is legal. Throws on a prohibited target —
 * enforcement is at the transition, NEVER a runtime scan that finds the
 * connector already corrupt (§3.2).
 */
export function assertTransition(from: ConnectorState, to: ConnectorState): void {
  if (isProhibitedComposite(to)) {
    throw new Error(
      `ADR-004 §3.2: prohibited composite transition to ` +
        `(auth=${to.auth}, sync=${to.sync}, schema=${to.schema})`,
    );
  }
  void from; // reserved for future transition-legality rules (e.g. schema Current→Incompatible only via admin)
}

// ── The outage clock (§3.3) ──────────────────────────────────────────────
/** Set at the healthy → degraded transition; feeds decideServing's degradedSinceMs. */
export function outageClockStart(prevAuth: AuthState, nextAuth: AuthState, nowMs: number): number | undefined {
  return prevAuth === 'healthy' && nextAuth !== 'healthy' ? nowMs : undefined;
}

// ── Auto-resume (§3.4): Healthy AND one revalidation pass ────────────────
/**
 * Withholding lifts ONLY when the connector is back to Healthy AND one
 * complete live ACL re-validation pass has finished — `Healthy` alone never
 * resumes serving of withheld Critical content (it can flap Healthy before
 * ACLs re-verify). Idempotent (a state check, not an edge).
 */
export function canResume(auth: AuthState, revalidationComplete: boolean): boolean {
  return auth === 'healthy' && revalidationComplete;
}

// ── Throttled (§7.5 quota) ────────────────────────────────────────────────
/**
 * Quota exhaustion moves Sync into `throttled` — indexing jobs pause, but
 * class-1 (ACL/membership/delete) routing is NEVER touched (INV-9). This
 * predicate only reports the state; the scheduler owns the pause, and its
 * class-1 lane is unaffected by construction.
 */
export function throttledPausesIndexingOnly(): { pausesClasses: readonly number[]; neverSheds: readonly number[] } {
  return { pausesClasses: [2, 3, 4], neverSheds: [1] };
}

// ── The frozen §11.7 failure taxonomy (§3.5) ─────────────────────────────
export type FailureType =
  | 'transient'
  | 'permanent'
  | 'partial'
  | 'corrupt_poison'
  | 'duplicate_out_of_order'
  | 'clock_skew'
  | 'split_brain'
  | 'quota_exhaustion'
  | 'credential_compromise'
  | 'connectivity_loss'
  | 'byzantine_content';

export interface FailureRow {
  readonly type: FailureType;
  readonly recovery: string;
  readonly escalation: string;
  readonly ownerMechanism: string;
}

/** The 11 rows of §11.7, frozen as exported data. Every failure maps to exactly one. */
export const FAILURE_TAXONOMY: Readonly<Record<FailureType, FailureRow>> = {
  transient: { type: 'transient', recovery: 'automatic retry with jitter', escalation: 'none below retry budget', ownerMechanism: 'RetryManager (§4.7)' },
  permanent: { type: 'permanent', recovery: 'requires re-auth', escalation: 'admin notification', ownerMechanism: 'Authentication region' },
  partial: { type: 'partial', recovery: 'degrade the failing capability only', escalation: 'health score decay', ownerMechanism: 'capability negotiation (§10.2)' },
  corrupt_poison: { type: 'corrupt_poison', recovery: 'dead-letter after retry budget', escalation: 'admin DLQ surfacing', ownerMechanism: 'RetryManager / DLQ (§4.7)' },
  duplicate_out_of_order: { type: 'duplicate_out_of_order', recovery: 'idempotent no-op', escalation: 'none — normal operation', ownerMechanism: 'idempotent consumers (§14.3)' },
  clock_skew: { type: 'clock_skew', recovery: 'N/A by construction (revision vectors)', escalation: 'none', ownerMechanism: 'revision vectors (§14.1, INV-7)' },
  split_brain: { type: 'split_brain', recovery: 'stale-token writer rejected', escalation: 'logged; investigate if repeated', ownerMechanism: 'fencing tokens (§4.7, INV-8)' },
  quota_exhaustion: { type: 'quota_exhaustion', recovery: 'Throttled sub-state; bias to index', escalation: 'admin if sustained', ownerMechanism: 'quota exhaustion (§7.5)' },
  credential_compromise: { type: 'credential_compromise', recovery: 'immediate rotation, sessions revoked', escalation: 'security incident', ownerMechanism: 'Authentication region (§11.1, §12.5)' },
  connectivity_loss: { type: 'connectivity_loss', recovery: 'freshness-gated read-only; auto-resume on Healthy', escalation: 'admin if sustained', ownerMechanism: 'Degraded / §6.6 (§11.1)' },
  byzantine_content: { type: 'byzantine_content', recovery: 'quarantine, excluded from context', escalation: 'admin surfacing', ownerMechanism: 'content trust boundary (§22, ADR-011)' },
};

export interface FailureSignal {
  readonly httpStatus?: number;
  readonly kind?: FailureType;
  readonly detail?: string;
}

/**
 * Map a failure signal to exactly one taxonomy row (§3.5). A signal matching
 * no row THROWS — a new failure mode requires a new taxonomy row (§8), never
 * a silent catch-all.
 */
export function classifyFailure(signal: FailureSignal): FailureRow {
  if (signal.kind) {
    const row = FAILURE_TAXONOMY[signal.kind];
    if (!row) throw new Error(`ADR-004 §3.5: unknown failure type '${signal.kind}' — a new taxonomy row is required`);
    return row;
  }
  const s = signal.httpStatus;
  if (s === undefined) throw new Error('ADR-004 §3.5: failure signal carries neither kind nor httpStatus');
  if (s === 429) return FAILURE_TAXONOMY.quota_exhaustion;
  if (s === 401 || s === 403) return FAILURE_TAXONOMY.permanent;
  if (s >= 500) return FAILURE_TAXONOMY.transient;
  if (s === 408 || s === 0) return FAILURE_TAXONOMY.connectivity_loss;
  throw new Error(`ADR-004 §3.5: HTTP ${s} maps to no failure taxonomy row — classify explicitly or add a row`);
}
