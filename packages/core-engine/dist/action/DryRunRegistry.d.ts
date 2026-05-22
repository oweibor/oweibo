/**
 * T.−1: DryRunRegistry — read-side accessor for action proposals.
 *
 * ActionTrustLadder writes proposals; DryRunRegistry serves the admin UI and
 * operator queries that list/inspect them. Keeping reads separate from the
 * gate keeps the gate's hot path lean.
 *
 * All queries run with the tenant's RLS scope applied — the registry must
 * be called from a context where the caller has already verified the
 * principal's tenant binding (typically via withTenantContext on the HTTP
 * route, which sets app.tenant_id before invoking the registry).
 */
import type { Pool } from 'pg';
import type { GatePrincipal } from '@oweibo/core-contracts';
export interface ProposalSummary {
    id: string;
    tenantId: string;
    userId: string | null;
    actionClass: string;
    actionId: string;
    mode: 'dry_run' | 'shadow' | 'require_approval';
    summary: string;
    rollbackKind: 'trivial' | 'reversible_with_cost' | 'irreversible' | null;
    state: 'pending' | 'promoted' | 'rejected' | 'expired' | 'executed_shadow' | 'executed_live';
    createdAt: string;
    expiresAt: string;
    decidedAt: string | null;
    decidedBy: string | null;
    decisionReason: string | null;
}
export interface ProposalDetail extends ProposalSummary {
    payload: unknown;
    rollbackDetail: unknown;
}
export interface ListFilters {
    /** Filter by state. Defaults to ['pending'] if omitted. */
    state?: ProposalSummary['state'][];
    /** Filter by action class. */
    actionClass?: string;
    /** Cursor-style pagination. */
    beforeCreatedAt?: string;
    /** Result cap. Hard ceiling of 200. */
    limit?: number;
}
export declare class DryRunRegistry {
    private readonly pool;
    constructor(pool: Pool);
    /** List proposals visible to the principal's tenant. */
    list(principal: GatePrincipal, filters?: ListFilters): Promise<ProposalSummary[]>;
    /** Fetch a single proposal including its full payload and rollback detail. */
    get(principal: GatePrincipal, proposalId: string): Promise<ProposalDetail | null>;
    /** Read the per-(tenant, class) trust matrix. Includes only explicit rows. */
    listTrustMatrix(principal: GatePrincipal): Promise<TrustMatrixRow[]>;
    /** Pin a class to a specific mode. Pinned classes do not auto-promote. */
    pin(principal: GatePrincipal, actionClass: string, mode: 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden', reason: string): Promise<void>;
    /** Remove an operator pin. State row is preserved so observation counters survive. */
    unpin(principal: GatePrincipal, actionClass: string): Promise<void>;
}
export interface TrustMatrixRow {
    actionClass: string;
    currentMode: string;
    pinnedBy: string | null;
    pinnedReason: string | null;
    observations: number;
    successes: number;
    rejections: number;
    lastUpdated: string;
}
//# sourceMappingURL=DryRunRegistry.d.ts.map