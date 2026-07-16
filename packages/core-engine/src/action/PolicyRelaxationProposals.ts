/**
 * ADR-006 §3.4 — durable proposal rows for the reserved action class
 * `governance.policy_relaxation`.
 *
 * A policy relaxation IS an action proposal: it reuses `action_proposals`
 * (mode 'require_approval', state 'pending' → 'promoted' | 'rejected') and
 * the `approval_votes` ledger via MultiPartyApprovalService.castVote — so a
 * relaxation shows up in the same audit surfaces as every other gated action.
 * This store lives in `action/` with the other action_proposals writers
 * (ActionTrustLadder, ActionPlanGate, ShadowExecutor, RollbackOrchestrator):
 * the Execution Runtime stays the entity's sole-writer subsystem (INV-16).
 *
 * The store is deliberately dumb: rows in, rows out, conditional state
 * transitions. Classification, the quorum floor, and the apply leg are the
 * Governance Plane's (fabric/policy/PolicyRelaxationFlow) — this file must
 * not import fabric code, both to keep the dependency direction one-way and
 * because a proposal row is evidence, not a decision.
 */
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';

/** Kept as a literal so this file needs no fabric import; the flow asserts
 *  it matches fabric/policy/contract's POLICY_RELAXATION_ACTION_CLASS. */
export const RELAXATION_PROPOSAL_CLASS = 'governance.policy_relaxation';

export interface RelaxationProposalRecord {
  readonly id: string;
  readonly tenantId: string;
  /** The proposing principal — quorum counts them as at most one (§3.4). */
  readonly proposerUserId: string;
  readonly summary: string;
  /** The proposed change set, exactly as submitted (validated upstream). */
  readonly changes: unknown;
  readonly state: 'pending' | 'promoted' | 'rejected' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RelaxationVoteRecord {
  readonly voterUserId: string;
  readonly vote: 'approve' | 'reject';
  /** Delegated votes NEVER count toward relaxation quorum (§3.4 rule 2). */
  readonly viaDelegation: boolean;
}

export class PolicyRelaxationProposals {
  constructor(private readonly pool: Pool) {}

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async create(input: {
    readonly tenantId: string;
    readonly proposerUserId: string;
    readonly summary: string;
    readonly changes: unknown;
  }): Promise<{ id: string }> {
    return this.withTenant(input.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO oweibo.action_proposals
           (tenant_id, user_id, action_class, action_id, mode, summary, payload, state)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'require_approval', $5, $6::jsonb, 'pending')
         RETURNING id`,
        [
          input.tenantId,
          input.proposerUserId,
          RELAXATION_PROPOSAL_CLASS,
          `policy-relaxation:${randomUUID()}`,
          input.summary,
          JSON.stringify({ changes: input.changes }),
        ],
      );
      return { id: r.rows[0]!.id };
    });
  }

  /** Fetch ONE relaxation proposal. Rows of any other class are invisible here. */
  async get(tenantId: string, proposalId: string): Promise<RelaxationProposalRecord | null> {
    const rows = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT id, tenant_id, user_id, summary, payload, state, created_at, expires_at
           FROM oweibo.action_proposals
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND action_class = $3`,
        [proposalId, tenantId, RELAXATION_PROPOSAL_CLASS],
      ),
    );
    const row = rows.rows[0];
    return row ? toRecord(row) : null;
  }

  async listPending(tenantId: string): Promise<readonly RelaxationProposalRecord[]> {
    const rows = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT id, tenant_id, user_id, summary, payload, state, created_at, expires_at
           FROM oweibo.action_proposals
          WHERE tenant_id = $1::uuid AND action_class = $2 AND state = 'pending'
          ORDER BY created_at ASC`,
        [tenantId, RELAXATION_PROPOSAL_CLASS],
      ),
    );
    return rows.rows.map(toRecord);
  }

  /**
   * Conditional resolve: pending → promoted | rejected. Returns false when
   * another voter's evaluation already resolved it (the apply leg is
   * idempotent, so losing this race is harmless).
   */
  async resolve(input: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly state: 'promoted' | 'rejected';
    readonly decidedBy: string;
    readonly reason: string;
  }): Promise<boolean> {
    const r = await this.withTenant(input.tenantId, (c) =>
      c.query(
        `UPDATE oweibo.action_proposals
            SET state = $3, decided_by = $4::uuid, decided_at = NOW(), decision_reason = $5
          WHERE id = $1::uuid AND tenant_id = $2::uuid
            AND action_class = $6 AND state = 'pending'`,
        [input.proposalId, input.tenantId, input.state, input.decidedBy, input.reason, RELAXATION_PROPOSAL_CLASS],
      ),
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** The raw vote ledger for a proposal (read-only; castVote is the writer). */
  async listVotes(tenantId: string, proposalId: string): Promise<readonly RelaxationVoteRecord[]> {
    const rows = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT voter_user_id, vote, via_delegation
           FROM oweibo.approval_votes
          WHERE tenant_id = $1::uuid AND proposal_id = $2::uuid
          ORDER BY voted_at ASC`,
        [tenantId, proposalId],
      ),
    );
    return rows.rows.map((r) => ({
      voterUserId: r.voter_user_id as string,
      vote: r.vote as 'approve' | 'reject',
      viaDelegation: r.via_delegation === true,
    }));
  }
}

function toRecord(row: Record<string, unknown>): RelaxationProposalRecord {
  const payload = (row['payload'] ?? {}) as { changes?: unknown };
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    proposerUserId: row['user_id'] as string,
    summary: row['summary'] as string,
    changes: payload.changes,
    state: row['state'] as RelaxationProposalRecord['state'],
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
    expiresAt: new Date(row['expires_at'] as string | Date).toISOString(),
  };
}
