/**
 * ADR-006 §3.4 — the relaxation-approval leg, wired through the shipped
 * multi-party machinery:
 *
 *   propose ──classify──► tightening: applies immediately (TenantPolicyService)
 *        │                relaxation: durable ballot (action_proposals row,
 *        │                            class governance.policy_relaxation)
 *        ▼
 *   each approver votes AS THEMSELVES (MultiPartyApprovalService.castVote —
 *   the vote row is keyed to the authenticated principal; there is no way to
 *   submit someone else's vote through this flow)
 *        │
 *        ▼
 *   AUTHORITATIVE evaluation: contract.evaluateQuorum over the RAW ledger
 *   (delegated votes excluded), against POLICY_RELAXATION_FLOOR — never
 *   against the tenant-configurable multiparty policy. A tenant that sets
 *   quorum=1 for the reserved class changes castVote's advisory tally and
 *   nothing else; the apply decision cannot be weakened from inside the
 *   tenant (§3.4 rule 5: the control's adversary must not configure it).
 *        │
 *   quorum ⇒ TenantPolicyService.applyApprovedRelaxation (which re-classifies
 *   inside the commit transaction under the per-tenant advisory lock) and the
 *   ballot resolves 'promoted'. Dissent ⇒ 'rejected', audited. Ties to the
 *   floor: grants are never consulted (a grant is pre-approval = single
 *   control), delegated votes never count.
 */
import { RELAXATION_PROPOSAL_CLASS } from '../../action/PolicyRelaxationProposals.js';
import {
  POLICY_RELAXATION_ACTION_CLASS,
  POLICY_RELAXATION_FLOOR,
  evaluateQuorum,
  type RelaxationVote,
} from './contract.js';
import type {
  ApplyResult,
  PolicyChangeRequest,
  TenantPolicyService,
} from './TenantPolicyService.js';

// ── Collaborator ports (structural; bound at composition) ────────────────

/** action/PolicyRelaxationProposals — the Execution-Runtime proposal store. */
export interface RelaxationProposalPort {
  create(input: {
    tenantId: string; proposerUserId: string; summary: string; changes: unknown;
  }): Promise<{ id: string }>;
  get(tenantId: string, proposalId: string): Promise<{
    id: string; tenantId: string; proposerUserId: string; summary: string;
    changes: unknown; state: 'pending' | 'promoted' | 'rejected' | 'expired';
    createdAt: string; expiresAt: string;
  } | null>;
  listPending(tenantId: string): Promise<readonly {
    id: string; proposerUserId: string; summary: string; changes: unknown;
    state: string; createdAt: string; expiresAt: string;
  }[]>;
  resolve(input: {
    tenantId: string; proposalId: string; state: 'promoted' | 'rejected';
    decidedBy: string; reason: string;
  }): Promise<boolean>;
  listVotes(tenantId: string, proposalId: string): Promise<readonly {
    voterUserId: string; vote: 'approve' | 'reject'; viaDelegation: boolean;
  }[]>;
}

/** MultiPartyApprovalService's vote leg. NOTE: no onBehalfOf in this port —
 *  delegation is structurally unavailable to the relaxation flow (§3.4 rule 2). */
export interface RelaxationVoteCaster {
  castVote(req: {
    tenantId: string; proposalId: string; voterUserId: string;
    vote: 'approve' | 'reject'; comment?: string;
  }): Promise<unknown>;
}

// ── Results ───────────────────────────────────────────────────────────────

export type RelaxationProposeResult =
  | ApplyResult // 'applied' (was provably a tightening) | 'no_change'
  | { readonly kind: 'pending_approval'; readonly proposalId: string; readonly quorum: number };

export type RelaxationVoteResult =
  | { readonly kind: 'pending'; readonly approvals: number; readonly quorum: number }
  | { readonly kind: 'applied'; readonly policyVersion: string; readonly backfillRequired: boolean }
  | { readonly kind: 'no_change' }
  | { readonly kind: 'vetoed'; readonly by: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_resolved'; readonly state: string };

export interface RelaxationStatus {
  readonly proposal: NonNullable<Awaited<ReturnType<RelaxationProposalPort['get']>>>;
  readonly votes: readonly { voterUserId: string; vote: 'approve' | 'reject'; viaDelegation: boolean }[];
  readonly quorum: number;
  readonly approvals: number;
}

export class PolicyRelaxationFlow {
  constructor(
    private readonly policy: TenantPolicyService,
    private readonly proposals: RelaxationProposalPort,
    private readonly voteCaster: RelaxationVoteCaster,
  ) {}

  /**
   * Propose a change set. Not-provably-tighter ⇒ a durable ballot instead of
   * a refusal — the §22 "second authorized approver" now has something to
   * approve. The proposer is the authenticated principal, never a body field.
   */
  async propose(req: PolicyChangeRequest): Promise<RelaxationProposeResult> {
    const direct = await this.policy.propose(req);
    if (direct.kind !== 'needs_dual_control') return direct;

    const dims = req.changes.map((c) => c.dimension).join(', ');
    const { id } = await this.proposals.create({
      tenantId: req.tenantId,
      proposerUserId: req.proposerId,
      summary: `Policy relaxation: ${dims}`,
      changes: req.changes,
    });
    return { kind: 'pending_approval', proposalId: id, quorum: POLICY_RELAXATION_FLOOR.quorum };
  }

  /**
   * Cast the authenticated principal's vote and evaluate. Approval at floor
   * quorum applies the relaxation in the same call; dissent vetoes it.
   */
  async vote(input: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly voterUserId: string;
    readonly vote: 'approve' | 'reject';
    readonly comment?: string;
  }): Promise<RelaxationVoteResult> {
    const proposal = await this.proposals.get(input.tenantId, input.proposalId);
    if (!proposal) return { kind: 'not_found' };
    if (proposal.state !== 'pending') return { kind: 'already_resolved', state: proposal.state };

    try {
      await this.voteCaster.castVote({
        tenantId: input.tenantId,
        proposalId: input.proposalId,
        voterUserId: input.voterUserId,
        vote: input.vote,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      });
    } catch (e) {
      // castVote refuses votes on non-pending proposals — a concurrent voter
      // resolved it between our read and the cast.
      const current = await this.proposals.get(input.tenantId, input.proposalId);
      if (current && current.state !== 'pending') {
        return { kind: 'already_resolved', state: current.state };
      }
      throw e;
    }

    return this.evaluate(input.tenantId, proposal, input.voterUserId);
  }

  /** Read-only status for the admin surface. */
  async status(tenantId: string, proposalId: string): Promise<RelaxationStatus | null> {
    const proposal = await this.proposals.get(tenantId, proposalId);
    if (!proposal) return null;
    const votes = await this.proposals.listVotes(tenantId, proposalId);
    const eligible = votes.filter((v) => !v.viaDelegation);
    return {
      proposal,
      votes: [...votes],
      quorum: POLICY_RELAXATION_FLOOR.quorum,
      approvals: new Set(eligible.filter((v) => v.vote === 'approve').map((v) => v.voterUserId)).size,
    };
  }

  async listPending(tenantId: string) {
    return this.proposals.listPending(tenantId);
  }

  private async evaluate(
    tenantId: string,
    proposal: NonNullable<Awaited<ReturnType<RelaxationProposalPort['get']>>>,
    decidedBy: string,
  ): Promise<RelaxationVoteResult> {
    // The RAW ledger, delegated votes excluded (§3.4 rule 2): a delegated
    // vote may sit in the audit trail, but it can never count toward
    // relaxation quorum — regardless of what the tenant's multiparty policy
    // row says about delegation.
    const ledger = await this.proposals.listVotes(tenantId, proposal.id);
    const votes: RelaxationVote[] = ledger
      .filter((v) => !v.viaDelegation)
      .map((v) => ({ principalId: v.voterUserId, approve: v.vote === 'approve' }));

    const verdict = evaluateQuorum(proposal.proposerUserId, votes, POLICY_RELAXATION_FLOOR.quorum);

    if (verdict.kind === 'vetoed') {
      await this.proposals.resolve({
        tenantId, proposalId: proposal.id, state: 'rejected',
        decidedBy, reason: `dissent veto by ${verdict.by}`,
      });
      return { kind: 'vetoed', by: verdict.by };
    }
    if (verdict.kind === 'pending') {
      return { kind: 'pending', approvals: verdict.have, quorum: verdict.need };
    }

    // Quorum reached — apply. applyApprovedRelaxation re-classifies inside
    // the commit transaction (advisory-locked), so concurrent approvers are
    // safe: the second apply sees no_change.
    const changeReq: PolicyChangeRequest = {
      tenantId,
      proposerId: proposal.proposerUserId,
      changes: proposal.changes as PolicyChangeRequest['changes'],
    };
    const applied = await this.policy.applyApprovedRelaxation(changeReq, votes);

    if (applied.kind === 'applied') {
      await this.proposals.resolve({
        tenantId, proposalId: proposal.id, state: 'promoted',
        decidedBy, reason: `quorum reached (${verdict.approvers.length} approvers); applied at policy version ${applied.policyVersion}`,
      });
      return { kind: 'applied', policyVersion: applied.policyVersion, backfillRequired: applied.backfillRequired };
    }
    if (applied.kind === 'no_change') {
      // The policy already holds the proposed values (e.g. an equivalent
      // change applied while this ballot was open). The ballot resolves —
      // there is nothing left to approve.
      await this.proposals.resolve({
        tenantId, proposalId: proposal.id, state: 'promoted',
        decidedBy, reason: 'quorum reached; change already effective (no_change)',
      });
      return { kind: 'no_change' };
    }
    if (applied.kind === 'rejected') {
      await this.proposals.resolve({
        tenantId, proposalId: proposal.id, state: 'rejected',
        decidedBy, reason: applied.reason,
      });
      return { kind: 'vetoed', by: decidedBy };
    }
    // needs_dual_control with quorum in hand is unreachable (same
    // evaluateQuorum, same floor) — surface pending defensively.
    return { kind: 'pending', approvals: votes.filter((v) => v.approve).length, quorum: POLICY_RELAXATION_FLOOR.quorum };
  }
}

// The store and the contract MUST agree on the reserved class name; a drift
// here would file ballots under a class the floor does not cover.
if ((RELAXATION_PROPOSAL_CLASS as string) !== POLICY_RELAXATION_ACTION_CLASS) {
  throw new Error(
    `PolicyRelaxationFlow: reserved class drift — store says ${RELAXATION_PROPOSAL_CLASS}, contract says ${POLICY_RELAXATION_ACTION_CLASS}`,
  );
}
