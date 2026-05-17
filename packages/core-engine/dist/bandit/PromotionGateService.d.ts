import type { Pool } from 'pg';
import type { CanonicalRole } from '@oweibo/core-contracts';
import type { BanditService } from './BanditService.js';
export interface PromotionCriteria {
    fromChannel: string;
    toChannel: string;
    slotId: string;
    armId: string;
    promptHash: string;
    humanApproved?: boolean;
}
export interface PendingPromotion {
    armId: string;
    slotId: string;
    role: CanonicalRole;
    promptHash: string;
    fromChannel: string;
    toChannel: string;
    /** Full gate result evaluated with humanApproved=true — i.e., what the outcome would be if approved. */
    gateResult: PromotionGateResult;
    /** Previously-decided rows for this arm in this direction (most-recent first). */
    priorDecisions: PromotionDecisionRecord[];
}
export interface PromotionDecisionRecord {
    id: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedAt: string;
    reason: string;
}
export interface GateCheck {
    name: string;
    passed: boolean;
    message: string;
    required: number | boolean;
    actual: number | boolean | null;
}
export interface PromotionGateResult {
    allowed: boolean;
    checks: GateCheck[];
    blockedBy: string[];
}
export declare class PromotionGateService {
    private readonly pool;
    /** Optional — required only for `recordDecision({decision:'approved'})`. */
    private readonly bandit?;
    constructor(pool: Pool, 
    /** Optional — required only for `recordDecision({decision:'approved'})`. */
    bandit?: BanditService | undefined);
    /**
     * Evaluate all gate checks for a proposed promotion.
     * Returns allowed=true only if every check passes.
     */
    evaluate(criteria: PromotionCriteria): Promise<PromotionGateResult>;
    /**
     * List arms whose only remaining blocker is the human_approval gate
     * (i.e. promotion would succeed if a human approves now).
     *
     * Scans every (from,to) channel pair whose rule has `requires_human_approval=true`,
     * for every arm currently active on the from-channel that hasn't already been
     * decided (approved OR rejected) in this direction. Default: beta→stable.
     */
    listPending(): Promise<PendingPromotion[]>;
    /**
     * Record a human approve/reject decision and, on approve, flip the channel pointer.
     *
     * Approval path: re-evaluates gates with `humanApproved=true`; if all pass,
     * calls BanditService.promoteArm() (optimistic-lock on channels.version) then
     * writes the decision row. Throws if BanditService wasn't provided or if the
     * gate would still block for non-human reasons.
     *
     * Rejection path: writes the decision row without touching channels.
     * The same arm can later become eligible again — the rejection is just an
     * audit record that prevents re-surfacing this candidate in listPending().
     */
    recordDecision(input: {
        armId: string;
        slotId: string;
        role: CanonicalRole;
        promptHash: string;
        fromChannel: string;
        toChannel: string;
        decision: 'approved' | 'rejected';
        decidedBy: string;
        reason: string;
    }): Promise<{
        ok: true;
        gateResult: PromotionGateResult;
    } | {
        ok: false;
        gateResult: PromotionGateResult;
    }>;
    /** Most-recent decisions, newest first. Used by the admin-web history panel. */
    listRecentDecisions(limit?: number): Promise<Array<PromotionDecisionRecord & {
        armId: string;
        slotId: string;
        role: string;
        fromChannel: string;
        toChannel: string;
        promptHash: string;
    }>>;
}
//# sourceMappingURL=PromotionGateService.d.ts.map