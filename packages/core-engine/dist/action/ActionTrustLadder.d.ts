/**
 * T.−1: ActionTrustLadder — the runtime implementation of IActionGate.
 *
 * Resolves a (tenant, action_class) trust state from the pinned/observed state
 * in oweibo.tenant_action_class_state (when present) or the platform-default
 * matrix below (when absent). Records dry-run / shadow / require-approval
 * proposals into oweibo.action_proposals.
 *
 * Hot path: gate() reads accountAgeDays and per-class scores from the caller-
 * supplied calibration snapshot (T.5.a) to avoid a DB round-trip on every
 * action. A DB query is only required when:
 *   - a tenant has a row in tenant_action_class_state (rare for established
 *     tenants; common only for cold-start tenants with pinned modes), or
 *   - the gate decides to write a proposal row (dry_run / shadow / approval).
 *
 * Backwards compatibility: with feature flag action_trust_ladder.enabled =
 * false, gate() returns { mode: 'execute' } deterministically. With the flag
 * on but no row in tenant_action_class_state (zero rows = pre-existing
 * tenant), the platform-default matrix returns 'execute' for any tenant with
 * accountAgeDays >= 30.
 *
 * Auto-promotion: a class with observations >= 10, success_rate >= 0.95,
 * accountAgeDays >= 7, not pinned, and not in the always-require-approval
 * group can auto-promote from dry_run to execute. Promotion runs lazily on
 * the next gate() call after the threshold is reached.
 */
import type { Pool } from 'pg';
import type { ActionContext, GateDecision, GatePrincipal, IActionGate } from '@oweibo/core-contracts';
export type TrustMode = 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';
export interface ActionTrustLadderOptions {
    /**
     * Returns true when the trust ladder should run. When false, gate() returns
     * { mode: 'execute' } deterministically (behavior byte-identical to today).
     * Default: env('ACTION_TRUST_LADDER_ENABLED') === 'true'.
     */
    isEnabled?: () => boolean;
    /**
     * Shadow-only mode: the gate still computes its decision and writes the
     * proposal row, but the returned mode is always 'execute'. Used during
     * the 14-day rollout window. Default: env('ACTION_TRUST_LADDER_SHADOW_ONLY')
     * === 'true'.
     */
    isShadowOnly?: () => boolean;
    /** Optional override for clock; tests pin time. */
    now?: () => Date;
}
export declare class ActionTrustLadder implements IActionGate {
    private readonly pool;
    private readonly isEnabled;
    private readonly isShadowOnly;
    private readonly now;
    constructor(pool: Pool, opts?: ActionTrustLadderOptions);
    gate(ctx: ActionContext): Promise<GateDecision>;
    promote(promoteId: string, principal: GatePrincipal, outcome: 'success' | 'failure'): Promise<void>;
    reject(promoteId: string, principal: GatePrincipal, reason: string): Promise<void>;
    private resolveState;
    private platformDefault;
    private recordProposal;
}
/** Helper used by callers to construct a deterministic actionId from inputs. */
export declare function deriveActionId(parts: readonly string[]): string;
/** Convenience: a randomly-generated actionId for one-off calls. */
export declare function randomActionId(): string;
//# sourceMappingURL=ActionTrustLadder.d.ts.map