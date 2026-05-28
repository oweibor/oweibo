/**
 * S.4 (ttv-action-safety-v2): multi-party + time-windowed approval contracts.
 *
 * Defines:
 *   * MultiPartyApprovalPolicy   — per-(tenant, action_class) quorum config
 *   * TimeWindowedGrant          — bounded "approve class X for N actions"
 *   * ApprovalDelegation         — bounded "user A delegates to user B"
 *   * ApprovalVote               — single approver's vote against a proposal
 *   * GrantCheckResult           — what the trust ladder gets when consulting grants
 *
 * Layering note: this file is pure data + interface. It is consumed by the
 * MultiPartyApprovalService (engine) and the admin UI (apps/admin-web).
 * Zero runtime imports per core-contracts hygiene.
 */
import type { ActionClass } from './ActionClass.js';
export interface MultiPartyApprovalPolicy {
    readonly tenantId: string;
    /** Specific class or `'*'` for the tenant default. */
    readonly actionClass: ActionClass | '*';
    /** Required approver count to promote (1 = single-approver, no quorum). */
    readonly quorum: number;
    /** Whether a single dissent vetoes (true) or only counts as one non-approval (false). */
    readonly dissentVetoes: boolean;
    /** Whether time-windowed grants may be issued for this class. */
    readonly allowGrants: boolean;
    /** Maximum duration (seconds) a grant for this class may cover. */
    readonly maxGrantDurationSeconds: number;
    /** Maximum action count a single grant may cover. */
    readonly maxGrantActionCount: number;
    /** Whether delegation of approval authority is permitted. */
    readonly allowDelegation: boolean;
}
export type GrantState = 'active' | 'exhausted' | 'expired' | 'revoked';
export interface GrantScopeFilter {
    /** Dot-path into the action payload, e.g. `payload.table`. */
    readonly fieldPath: string;
    readonly operator: 'eq' | 'in' | 'matches';
    readonly value: unknown;
}
export interface TimeWindowedGrant {
    readonly id: string;
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    /** User IDs of approvers who granted this (one per quorum member). */
    readonly grantedByUserIds: readonly string[];
    readonly grantedToKind: 'agent' | 'user';
    /** Set when grantedToKind === 'user'; the user who may exercise the grant. */
    readonly grantedToUserId?: string;
    readonly scopeFilter?: GrantScopeFilter;
    readonly expiresAt: string;
    readonly maxUses: number;
    readonly uses: number;
    readonly state: GrantState;
    readonly revokedByUserId?: string;
    readonly revokedAt?: string;
    readonly createdAt: string;
}
export interface CreateGrantRequest {
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    readonly grantedByUserIds: readonly string[];
    readonly grantedToKind: 'agent' | 'user';
    readonly grantedToUserId?: string;
    readonly scopeFilter?: GrantScopeFilter;
    readonly durationSeconds: number;
    readonly maxUses: number;
}
export interface ApprovalDelegation {
    readonly delegatorUserId: string;
    readonly delegateUserId: string;
    readonly tenantId: string;
    readonly actionClass: ActionClass | '*';
    readonly expiresAt: string;
    readonly revokedAt?: string;
    readonly createdAt: string;
}
export interface ApprovalVote {
    readonly proposalId: string;
    readonly voterUserId: string;
    readonly tenantId: string;
    readonly vote: 'approve' | 'reject';
    readonly comment?: string;
    readonly viaDelegation: boolean;
    readonly delegatorUserId?: string;
    readonly votedAt: string;
}
export interface CastVoteRequest {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly voterUserId: string;
    readonly vote: 'approve' | 'reject';
    readonly comment?: string;
    /**
     * If the voter is acting on a delegation, the delegator is recorded for
     * audit. The service verifies the delegation row exists before honoring.
     */
    readonly onBehalfOf?: string;
}
export type QuorumStatus = {
    kind: 'pending';
    approves: number;
    rejects: number;
    quorum: number;
} | {
    kind: 'approved';
    approves: number;
    rejects: number;
    quorum: number;
} | {
    kind: 'rejected';
    approves: number;
    rejects: number;
    quorum: number;
    reason: 'dissent_veto' | 'quorum_impossible';
};
export interface GrantCheckRequest {
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    readonly grantedToKind: 'agent' | 'user';
    readonly grantedToUserId?: string;
    /** The full payload — used to evaluate any scope_filter. */
    readonly payload: unknown;
}
export type GrantCheckResult = {
    kind: 'no_grant';
} | {
    kind: 'grant_consumed';
    grantId: string;
};
/**
 * Pluggable seam consumed by the ActionTrustLadder. The trust ladder calls
 * `tryConsume()` BEFORE recording a require_approval proposal. When the
 * result is `grant_consumed`, the gate returns `execute` and tags the
 * resulting proposal row (if any) with `grant_id`.
 */
export interface IMultiPartyApprovalService {
    tryConsume(req: GrantCheckRequest): Promise<GrantCheckResult>;
}
//# sourceMappingURL=ApprovalGrant.d.ts.map