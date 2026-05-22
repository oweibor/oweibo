/**
 * T.−1: ShadowExecutor — records the outcome of an action executed against
 * a tenant's pre-declared shadow target.
 *
 * The action *is* executed (by the action issuer itself, routing to the
 * shadow target) but only against the shadow surface. This service records
 * the outcome and any parity-with-prod assessment so operators can promote
 * shadow → live with one click.
 *
 * Per-integration shadow targets (sandbox DB, *_canary API namespace) are
 * declared by the connector registry (T.2.f). Until that lands, shadow
 * execution is a no-op for most classes and this service only records the
 * outcome shape required by the auto-promotion accounting in T.−1.
 */
import type { Pool } from 'pg';
import type { GatePrincipal } from '@oweibo/core-contracts';
export type ShadowParity = 'parity' | 'drift' | 'unknown';
export interface ShadowOutcome {
    /** The proposal id returned by ActionTrustLadder.gate() when mode === 'shadow'. */
    readonly proposalId: string;
    /** Did the shadow execution itself succeed? */
    readonly success: boolean;
    /** Did the shadow outcome match what would have happened in prod? */
    readonly parity: ShadowParity;
    /** Optional diff payload surfaced in the admin UI. */
    readonly diff?: unknown;
    /** Optional free-form reason / error string. */
    readonly reason?: string;
}
export declare class ShadowExecutor {
    private readonly pool;
    constructor(pool: Pool);
    /**
     * Record a shadow execution outcome.
     *
     * Per the plan's observation accounting:
     *   - shadow succeeds AND parity == 'parity' → +1 observation, +1 success
     *   - shadow succeeds AND parity == 'drift'  → +1 observation, +1 rejection
     *   - shadow fails                           → +1 observation, +1 rejection
     *   - parity == 'unknown'                    → +1 observation only
     */
    recordOutcome(principal: GatePrincipal, outcome: ShadowOutcome): Promise<void>;
}
//# sourceMappingURL=ShadowExecutor.d.ts.map