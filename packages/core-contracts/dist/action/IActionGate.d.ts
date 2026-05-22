/**
 * T.−1: IActionGate — the gate every real-world action passes through.
 *
 * Wrap an execution call with `await actionGate.gate(ctx)`. The returned
 * decision indicates whether to execute live, record a dry-run proposal,
 * route to a shadow target, request approval, or block outright.
 *
 * With the action_trust_ladder.enabled feature flag off, `gate()` returns
 * { mode: 'execute' } deterministically — behavior is byte-identical to
 * the pre-T.−1 codepath.
 */
import type { ActionClass } from './ActionClass.js';
export interface ActionContext {
    readonly tenantId: string;
    readonly userId: string;
    readonly actionClass: ActionClass;
    /** Deterministic id for idempotency: same actionId is never doubled. */
    readonly actionId: string;
    /** Human-readable: e.g. "delete file foo.txt". */
    readonly summary: string;
    /** Full machine-readable detail; surfaced to operators. */
    readonly payload: unknown;
    readonly rollback?: RollbackEnvelope;
    /**
     * Per-task tenant calibration snapshot, threaded through every action
     * emitted by the task. Resolved once at task start via CalibrationService
     * (T.5.a) and pinned for the snapshot's lifetime. The trust ladder reads
     * accountAgeDays and per-class scores from here to avoid a DB round-trip
     * on every gate() call.
     */
    readonly calibrationSnapshot: TenantReadinessSnapshot;
}
/**
 * Minimal subset of TenantReadiness (T.5.a) needed by the gate. Carries
 * pinned accountAgeDays + per-class scores so the gate does not re-query
 * the DB. The `sourceSig` is issued by CalibrationService and verified by
 * the gate to prevent inline construction by tools.
 */
export interface TenantReadinessSnapshot {
    readonly tenantId: string;
    readonly accountAgeDays: number;
    readonly actionClassScores: Readonly<Record<string, number>>;
    readonly snapshotAt: string;
    readonly sourceSig: string;
}
export interface RollbackEnvelope {
    readonly kind: 'trivial' | 'reversible_with_cost' | 'irreversible';
    readonly details: string;
    readonly rollbackPlan?: unknown;
}
export type GateDecision = {
    mode: 'execute';
} | {
    mode: 'dry_run';
    proposalId: string;
} | {
    mode: 'shadow';
    shadowId: string;
} | {
    mode: 'require_approval';
    approvalId: string;
} | {
    mode: 'forbidden';
    reason: string;
};
/** Minimal principal shape — the gate needs identity for audit; full type lives in @oweibo/db. */
export interface GatePrincipal {
    readonly sub: string;
    readonly scopes: readonly string[];
    readonly ctx: {
        readonly tenantId?: string;
    };
}
export interface IActionGate {
    gate(ctx: ActionContext): Promise<GateDecision>;
    /**
     * Called when a dry_run / shadow / require_approval proposal is later
     * promoted to live execution. Updates observation counters based on the
     * actual live-execution outcome supplied.
     */
    promote(promoteId: string, principal: GatePrincipal, outcome: 'success' | 'failure'): Promise<void>;
    /** Called when a proposal is rejected. Counts as 1 observation, 1 rejection. */
    reject(promoteId: string, principal: GatePrincipal, reason: string): Promise<void>;
}
//# sourceMappingURL=IActionGate.d.ts.map