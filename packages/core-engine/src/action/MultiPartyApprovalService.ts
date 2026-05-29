/**
 * S.4: MultiPartyApprovalService — quorum approvals, time-windowed grants,
 * and bounded delegation.
 *
 * Three responsibilities:
 *   1. `tryConsume(req)` — called by ActionTrustLadder.gate() BEFORE
 *      returning require_approval. If an active grant covers this action,
 *      the call atomically increments `uses` and returns the grant id so
 *      the gate can short-circuit to `execute` and audit the grant.
 *   2. `castVote(req)` — records a single approver's vote. When the row
 *      either (a) crosses the policy's `quorum` for approves or (b)
 *      crosses dissent-veto, returns a `QuorumStatus` that the lifecycle
 *      worker uses to promote/reject the proposal.
 *   3. `createGrant(req)` — writes a grant row after the per-class policy
 *      checks pass (allowGrants, ≤ maxGrantDurationSeconds, ≤ maxGrantActionCount).
 *
 * Policy resolution order mirrors the SLA service (S.1):
 *   1. tenant + actionClass exact match
 *   2. tenant + '*' default
 *   3. PLATFORM_DEFAULT_POLICY (matrix below)
 *
 * Feature flag (`MULTI_PARTY_APPROVAL_ENABLED`):
 *   - off ⇒ tryConsume always returns `no_grant` (gate behavior unchanged);
 *     castVote/createGrant still work for tenants exercising it manually.
 *
 * The service does NOT trigger notifications itself; the lifecycle worker
 * (S.1) observes proposal state transitions and dispatches.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ActionClass,
  CastVoteRequest,
  CreateGrantRequest,
  GrantCheckRequest,
  GrantCheckResult,
  GrantScopeFilter,
  IMultiPartyApprovalService,
  MultiPartyApprovalPolicy,
  QuorumStatus,
  TimeWindowedGrant,
} from '@oweibo/core-contracts';

// ── Default policy matrix ────────────────────────────────────────────────
//
// Mirrors the table in ttv-action-safety-v2.md S.4. Longest-prefix wins.

interface DefaultPolicy {
  quorum: number;
  dissentVetoes: boolean;
  allowGrants: boolean;
  maxGrantDurationSeconds: number;
  maxGrantActionCount: number;
  allowDelegation: boolean;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

const DEFAULT_MATRIX: ReadonlyArray<{ prefix: string; policy: DefaultPolicy }> = [
  // financial.* — quorum 2 only for material moves; the threshold is enforced
  // in the policy resolver via tenant override since it depends on payload.
  { prefix: 'financial.payment',          policy: { quorum: 2, dissentVetoes: true,  allowGrants: false, maxGrantDurationSeconds: HOUR,     maxGrantActionCount: 10,  allowDelegation: false } },
  { prefix: 'financial.',                 policy: { quorum: 1, dissentVetoes: true,  allowGrants: true,  maxGrantDurationSeconds: 4*HOUR,   maxGrantActionCount: 50,  allowDelegation: true  } },
  { prefix: 'personnel.access_grant',     policy: { quorum: 2, dissentVetoes: true,  allowGrants: false, maxGrantDurationSeconds: HOUR,     maxGrantActionCount: 5,   allowDelegation: false } },
  { prefix: 'personnel.access_revoke',    policy: { quorum: 1, dissentVetoes: true,  allowGrants: true,  maxGrantDurationSeconds: 4*HOUR,   maxGrantActionCount: 20,  allowDelegation: true  } },
  { prefix: 'irreversible.delete_resource', policy: { quorum: 2, dissentVetoes: true, allowGrants: false, maxGrantDurationSeconds: HOUR,   maxGrantActionCount: 5,   allowDelegation: false } },
  { prefix: 'irreversible.public_publish', policy: { quorum: 2, dissentVetoes: true,  allowGrants: false, maxGrantDurationSeconds: HOUR,    maxGrantActionCount: 5,   allowDelegation: false } },
  { prefix: 'deploy.prod',                policy: { quorum: 2, dissentVetoes: true,  allowGrants: true,  maxGrantDurationSeconds: 2*HOUR,   maxGrantActionCount: 10,  allowDelegation: true  } },
  { prefix: 'write.tenant_db.prod',       policy: { quorum: 1, dissentVetoes: true,  allowGrants: true,  maxGrantDurationSeconds: 4*HOUR,   maxGrantActionCount: 500, allowDelegation: true  } },
  { prefix: 'write.external_api.prod',    policy: { quorum: 1, dissentVetoes: true,  allowGrants: true,  maxGrantDurationSeconds: 4*HOUR,   maxGrantActionCount: 200, allowDelegation: true  } },
];

const FALLBACK_DEFAULT: DefaultPolicy = {
  quorum: 1,
  dissentVetoes: true,
  allowGrants: true,
  maxGrantDurationSeconds: DAY,
  maxGrantActionCount: 100,
  allowDelegation: true,
};

export function platformDefaultMultiPartyPolicy(
  tenantId: string,
  actionClass: ActionClass,
): MultiPartyApprovalPolicy {
  let match: DefaultPolicy = FALLBACK_DEFAULT;
  let matchLen = 0;
  for (const entry of DEFAULT_MATRIX) {
    if (actionClass.startsWith(entry.prefix) && entry.prefix.length > matchLen) {
      match = entry.policy;
      matchLen = entry.prefix.length;
    }
  }
  return {
    tenantId,
    actionClass,
    quorum: match.quorum,
    dissentVetoes: match.dissentVetoes,
    allowGrants: match.allowGrants,
    maxGrantDurationSeconds: match.maxGrantDurationSeconds,
    maxGrantActionCount: match.maxGrantActionCount,
    allowDelegation: match.allowDelegation,
  };
}

// ── Service ──────────────────────────────────────────────────────────────

/**
 * Audit-fix (S.4): voter eligibility resolver. Called once per
 * castVote() to confirm the voter is actually in the approver set for
 * this proposal (resolved via org-graph / role / explicit-list per the
 * proposal's class policy). Without this seam, any authenticated user
 * within the tenant could INSERT a vote and skew the quorum tally.
 *
 * The resolver returns `true` when the voter is eligible. Returning
 * `false` causes castVote() to throw without inserting a row.
 * Implementations typically wrap OrgGraphService.resolveApprovers (or
 * the role-based equivalent) and check membership.
 *
 * When omitted, eligibility checking is skipped — preserves the
 * pre-fix behaviour for callers that do not yet wire org-graph.
 */
export interface IVoterEligibilityResolver {
  isEligible(args: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly actionClass: ActionClass;
    readonly voterUserId: string;
  }): Promise<boolean>;
}

export interface MultiPartyApprovalServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
  /**
   * S.4 audit-fix: optional voter eligibility resolver. When supplied,
   * castVote() rejects votes from users not in the resolved approver
   * set for the proposal's class. When omitted, votes are accepted
   * from any tenant member (the pre-fix behaviour); this leaves
   * eligibility enforcement to the calling API layer.
   */
  voterEligibilityResolver?: IVoterEligibilityResolver;
}

export class MultiPartyApprovalService implements IMultiPartyApprovalService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly voterEligibility?: IVoterEligibilityResolver;

  constructor(
    private readonly pool: Pool,
    opts: MultiPartyApprovalServiceOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.voterEligibility = opts.voterEligibilityResolver;
  }

  // ── Policy ─────────────────────────────────────────────────────────────

  async resolvePolicy(tenantId: string, actionClass: ActionClass): Promise<MultiPartyApprovalPolicy> {
    return this.tx(tenantId, async (client) => {
      const rows = await client.query<{
        action_class: string;
        quorum: number;
        dissent_vetoes: boolean;
        allow_grants: boolean;
        max_grant_duration_seconds: number;
        max_grant_action_count: number;
        allow_delegation: boolean;
      }>(
        `SELECT action_class, quorum, dissent_vetoes, allow_grants,
                max_grant_duration_seconds, max_grant_action_count, allow_delegation
           FROM oweibo.multi_party_approval_policies
          WHERE tenant_id = $1::uuid AND action_class IN ($2, '*')
          ORDER BY (action_class = $2) DESC
          LIMIT 1`,
        [tenantId, actionClass],
      );
      const row = rows.rows[0];
      if (!row) return platformDefaultMultiPartyPolicy(tenantId, actionClass);
      return {
        tenantId,
        actionClass: row.action_class as ActionClass | '*',
        quorum: row.quorum,
        dissentVetoes: row.dissent_vetoes,
        allowGrants: row.allow_grants,
        maxGrantDurationSeconds: row.max_grant_duration_seconds,
        maxGrantActionCount: row.max_grant_action_count,
        allowDelegation: row.allow_delegation,
      };
    });
  }

  // ── Grant consumption (trust ladder hot path) ─────────────────────────

  async tryConsume(req: GrantCheckRequest): Promise<GrantCheckResult> {
    if (!this.isEnabled()) return { kind: 'no_grant' };
    return this.tx(req.tenantId, async (client) => {
      // Find active candidate grants. Order by created_at DESC so newer
      // grants are exercised first (operators usually grant when an action
      // is about to be retried — the freshest grant wins).
      const rows = await client.query<{
        id: string;
        action_class: string;
        scope_filter: GrantScopeFilter | null;
        max_uses: number;
        uses: number;
      }>(
        `SELECT id, action_class, scope_filter, max_uses, uses
           FROM oweibo.time_windowed_grants
          WHERE tenant_id = $1::uuid
            AND action_class = $2
            AND state = 'active'
            AND expires_at > NOW()
            AND uses < max_uses
            AND granted_to_kind = $3
            AND (granted_to_kind = 'agent'
                 OR granted_to_user_id = $4::uuid)
          ORDER BY created_at DESC
          FOR UPDATE SKIP LOCKED`,
        [
          req.tenantId,
          req.actionClass,
          req.grantedToKind,
          req.grantedToUserId ?? null,
        ],
      );

      for (const row of rows.rows) {
        if (!matchesScope(req.payload, row.scope_filter ?? undefined)) continue;
        // Atomic claim: increment + transition to exhausted on the boundary.
        const claimed = await client.query<{ id: string }>(
          `UPDATE oweibo.time_windowed_grants
              SET uses = uses + 1,
                  state = CASE WHEN uses + 1 >= max_uses THEN 'exhausted' ELSE state END
            WHERE id = $1::uuid
              AND state = 'active'
              AND uses < max_uses
              AND expires_at > NOW()
            RETURNING id`,
          [row.id],
        );
        if (claimed.rows[0]) {
          return { kind: 'grant_consumed', grantId: claimed.rows[0].id };
        }
      }
      return { kind: 'no_grant' };
    });
  }

  // ── Grant CRUD ─────────────────────────────────────────────────────────

  /**
   * Create a grant. Throws if the per-class policy disallows grants or if
   * the requested duration/count exceeds policy caps. Callers SHOULD have
   * already authenticated that `grantedByUserIds` covers the class's quorum.
   */
  async createGrant(req: CreateGrantRequest): Promise<TimeWindowedGrant> {
    const policy = await this.resolvePolicy(req.tenantId, req.actionClass);
    if (!policy.allowGrants) {
      throw new Error(`grants disabled for ${req.actionClass} in tenant ${req.tenantId}`);
    }
    if (req.durationSeconds > policy.maxGrantDurationSeconds) {
      throw new Error(
        `grant duration ${req.durationSeconds}s exceeds policy cap ${policy.maxGrantDurationSeconds}s`,
      );
    }
    if (req.maxUses > policy.maxGrantActionCount) {
      throw new Error(
        `grant maxUses ${req.maxUses} exceeds policy cap ${policy.maxGrantActionCount}`,
      );
    }
    // Audit-fix: dedupe grantedByUserIds before the quorum check —
    // otherwise [u1, u1] satisfies quorum=2.
    const uniqueGrantedBy = Array.from(new Set(req.grantedByUserIds));
    if (uniqueGrantedBy.length < policy.quorum) {
      throw new Error(
        `grant requires ${policy.quorum} distinct approver(s); only ${uniqueGrantedBy.length} supplied`,
      );
    }
    if (req.grantedToKind === 'user' && !req.grantedToUserId) {
      throw new Error(`grantedToKind='user' requires grantedToUserId`);
    }

    const expiresAt = new Date(this.now().getTime() + req.durationSeconds * 1000);
    return this.tx(req.tenantId, async (client) => {
      const rows = await client.query<{
        id: string;
        created_at: Date;
      }>(
        `INSERT INTO oweibo.time_windowed_grants (
           tenant_id, action_class, granted_by_user_ids, granted_to_kind,
           granted_to_user_id, scope_filter, expires_at, max_uses
         ) VALUES (
           $1::uuid, $2, $3::uuid[], $4, $5::uuid, $6::jsonb, $7, $8
         )
         RETURNING id, created_at`,
        [
          req.tenantId,
          req.actionClass,
          uniqueGrantedBy,
          req.grantedToKind,
          req.grantedToUserId ?? null,
          req.scopeFilter ? JSON.stringify(req.scopeFilter) : null,
          expiresAt,
          req.maxUses,
        ],
      );
      const row = rows.rows[0];
      if (!row) throw new Error(`createGrant: insert returned no row`);
      const grant: TimeWindowedGrant = {
        id: row.id,
        tenantId: req.tenantId,
        actionClass: req.actionClass,
        grantedByUserIds: uniqueGrantedBy,
        grantedToKind: req.grantedToKind,
        ...(req.grantedToUserId ? { grantedToUserId: req.grantedToUserId } : {}),
        ...(req.scopeFilter ? { scopeFilter: req.scopeFilter } : {}),
        expiresAt: expiresAt.toISOString(),
        maxUses: req.maxUses,
        uses: 0,
        state: 'active',
        createdAt: row.created_at.toISOString(),
      };
      return grant;
    });
  }

  /**
   * Read-only list of active (non-expired, non-revoked, non-exhausted)
   * grants for the tenant. Used by the admin-web /approvals/grants page.
   * Returns rows ordered by created_at DESC (newest first), capped at 200.
   */
  async listGrants(tenantId: string): Promise<readonly TimeWindowedGrant[]> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<{
        id: string;
        action_class: string;
        granted_by_user_ids: string[];
        granted_to_kind: 'agent' | 'user';
        granted_to_user_id: string | null;
        scope_filter: GrantScopeFilter | null;
        expires_at: Date;
        max_uses: number;
        uses: number;
        state: 'active' | 'expired' | 'revoked' | 'exhausted';
        created_at: Date;
      }>(
        `SELECT id, action_class, granted_by_user_ids, granted_to_kind,
                granted_to_user_id, scope_filter, expires_at, max_uses, uses,
                state, created_at
           FROM oweibo.time_windowed_grants
          WHERE tenant_id = $1::uuid
            AND state = 'active'
            AND expires_at > NOW()
            AND uses < max_uses
          ORDER BY created_at DESC
          LIMIT 200`,
        [tenantId],
      );
      return r.rows.map<TimeWindowedGrant>((row) => ({
        id: row.id,
        tenantId,
        actionClass: row.action_class as ActionClass,
        grantedByUserIds: row.granted_by_user_ids,
        grantedToKind: row.granted_to_kind,
        ...(row.granted_to_user_id ? { grantedToUserId: row.granted_to_user_id } : {}),
        ...(row.scope_filter ? { scopeFilter: row.scope_filter } : {}),
        expiresAt: row.expires_at.toISOString(),
        maxUses: row.max_uses,
        uses: row.uses,
        state: row.state,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async revokeGrant(tenantId: string, grantId: string, revokedByUserId: string): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `UPDATE oweibo.time_windowed_grants
            SET state = 'revoked',
                revoked_by_user_id = $3::uuid,
                revoked_at = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND state = 'active'`,
        [grantId, tenantId, revokedByUserId],
      );
    });
  }

  // ── Voting ─────────────────────────────────────────────────────────────

  /**
   * Record a vote and return the new quorum status. The lifecycle worker
   * (S.1) interprets the returned status:
   *   - kind: 'approved'  → promote proposal to execute
   *   - kind: 'rejected'  → mark proposal rejected
   *   - kind: 'pending'   → keep awaiting more votes
   *
   * Idempotent at the (proposal, voter) level: a duplicate vote is a no-op
   * and returns the current tally.
   */
  async castVote(req: CastVoteRequest): Promise<QuorumStatus> {
    return this.tx(req.tenantId, async (client) => {
      // Look up the proposal's class so we can resolve the policy. Read
      // happens inside the tx so the snapshot is consistent with the vote
      // insert that follows. Audit-fix: also pull state and reject votes
      // on proposals that already resolved — accepting them is confusing
      // in the audit log and pollutes the tally.
      const propRows = await client.query<{ action_class: string; state: string }>(
        `SELECT action_class, state FROM oweibo.action_proposals
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          FOR UPDATE`,
        [req.proposalId, req.tenantId],
      );
      const prop = propRows.rows[0];
      if (!prop) throw new Error(`castVote: proposal ${req.proposalId} not found`);
      if (prop.state !== 'pending') {
        throw new Error(
          `castVote: proposal ${req.proposalId} is ${prop.state}; only pending proposals accept votes`,
        );
      }
      const policy = await this.resolvePolicyInTx(
        client,
        req.tenantId,
        prop.action_class as ActionClass,
      );

      // Audit-fix (S.4): confirm the voter is in the resolved approver
      // set for this proposal. When acting on behalf of someone, we
      // check the *delegator's* eligibility (the delegate borrows the
      // delegator's authority, not their own). When omitted, the check
      // is skipped — the calling API layer is responsible for
      // authorization in that case.
      if (this.voterEligibility) {
        const checkUserId = req.onBehalfOf ?? req.voterUserId;
        const eligible = await this.voterEligibility.isEligible({
          tenantId: req.tenantId,
          proposalId: req.proposalId,
          actionClass: prop.action_class as ActionClass,
          voterUserId: checkUserId,
        });
        if (!eligible) {
          throw new Error(
            `voter ${checkUserId} is not in the approver set for proposal ${req.proposalId}`,
          );
        }
      }

      let viaDelegation = false;
      let delegatorUserId: string | null = null;
      if (req.onBehalfOf) {
        if (!policy.allowDelegation) {
          throw new Error(
            `delegation disabled for ${prop.action_class} in tenant ${req.tenantId}`,
          );
        }
        const delegRows = await client.query<{ ok: boolean }>(
          `SELECT TRUE AS ok
             FROM oweibo.approval_delegations
            WHERE delegator_user_id = $1::uuid
              AND delegate_user_id  = $2::uuid
              AND tenant_id         = $3::uuid
              AND (action_class = $4 OR action_class = '*')
              AND expires_at > NOW()
              AND revoked_at IS NULL
            LIMIT 1`,
          [req.onBehalfOf, req.voterUserId, req.tenantId, prop.action_class],
        );
        if (!delegRows.rows[0]) {
          throw new Error(
            `no active delegation from ${req.onBehalfOf} to ${req.voterUserId} for ${prop.action_class}`,
          );
        }
        viaDelegation = true;
        delegatorUserId = req.onBehalfOf;
      }

      // Insert vote (idempotent — duplicate (proposal, voter) is no-op).
      await client.query(
        `INSERT INTO oweibo.approval_votes
           (proposal_id, voter_user_id, tenant_id, vote, comment,
            via_delegation, delegator_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)
         ON CONFLICT (proposal_id, voter_user_id) DO NOTHING`,
        [
          req.proposalId,
          req.voterUserId,
          req.tenantId,
          req.vote,
          req.comment ?? null,
          viaDelegation,
          delegatorUserId,
        ],
      );

      const tally = await client.query<{ vote: string; n: number }>(
        `SELECT vote, COUNT(*)::int AS n
           FROM oweibo.approval_votes
          WHERE proposal_id = $1::uuid
          GROUP BY vote`,
        [req.proposalId],
      );
      let approves = 0;
      let rejects = 0;
      for (const r of tally.rows) {
        if (r.vote === 'approve') approves = r.n;
        else if (r.vote === 'reject') rejects = r.n;
      }
      return tallyToStatus(approves, rejects, policy);
    });
  }

  /** Read-only tally; the worker uses this when advancing SLA stage. */
  async getQuorumStatus(tenantId: string, proposalId: string): Promise<QuorumStatus> {
    return this.tx(tenantId, async (client) => {
      const propRows = await client.query<{ action_class: string }>(
        `SELECT action_class FROM oweibo.action_proposals
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [proposalId, tenantId],
      );
      const prop = propRows.rows[0];
      if (!prop) throw new Error(`getQuorumStatus: proposal ${proposalId} not found`);
      const policy = await this.resolvePolicyInTx(
        client,
        tenantId,
        prop.action_class as ActionClass,
      );
      const tally = await client.query<{ vote: string; n: number }>(
        `SELECT vote, COUNT(*)::int AS n
           FROM oweibo.approval_votes
          WHERE proposal_id = $1::uuid
          GROUP BY vote`,
        [proposalId],
      );
      let approves = 0;
      let rejects = 0;
      for (const r of tally.rows) {
        if (r.vote === 'approve') approves = r.n;
        else if (r.vote === 'reject') rejects = r.n;
      }
      return tallyToStatus(approves, rejects, policy);
    });
  }

  // ── Delegation ─────────────────────────────────────────────────────────

  async createDelegation(args: {
    readonly tenantId: string;
    readonly delegatorUserId: string;
    readonly delegateUserId: string;
    readonly actionClass: ActionClass | '*';
    readonly durationSeconds: number;
  }): Promise<void> {
    if (args.delegatorUserId === args.delegateUserId) {
      throw new Error(`cannot delegate to self`);
    }
    const policy = args.actionClass === '*'
      ? FALLBACK_DEFAULT
      : await this.resolvePolicy(args.tenantId, args.actionClass);
    if (!policy.allowDelegation) {
      throw new Error(`delegation disabled for ${args.actionClass} in tenant ${args.tenantId}`);
    }
    const expiresAt = new Date(this.now().getTime() + args.durationSeconds * 1000);
    await this.tx(args.tenantId, async (client) => {
      // Audit-fix (S.4): non-transitive delegation. Single query checks
      // both chain directions atomically — (a) the delegate must not be
      // an active delegator, and (b) the delegator must not be an
      // active delegate. Doing this in one round-trip closes the
      // window where two concurrent createDelegation calls in opposite
      // chain directions could each pass the other's check.
      const chainCheck = await client.query<{ role: 'delegate_is_delegator' | 'delegator_is_delegate' }>(
        `SELECT 'delegate_is_delegator'::text AS role
           FROM oweibo.approval_delegations
          WHERE delegator_user_id = $1::uuid
            AND tenant_id = $3::uuid
            AND expires_at > NOW()
            AND revoked_at IS NULL
          UNION ALL
         SELECT 'delegator_is_delegate'::text AS role
           FROM oweibo.approval_delegations
          WHERE delegate_user_id = $2::uuid
            AND tenant_id = $3::uuid
            AND expires_at > NOW()
            AND revoked_at IS NULL
          LIMIT 1`,
        [args.delegateUserId, args.delegatorUserId, args.tenantId],
      );
      const conflict = chainCheck.rows[0]?.role;
      if (conflict === 'delegate_is_delegator') {
        throw new Error(
          `delegate ${args.delegateUserId} is already a delegator; delegation chains are not allowed`,
        );
      }
      if (conflict === 'delegator_is_delegate') {
        throw new Error(
          `delegator ${args.delegatorUserId} is already a delegate; delegation chains are not allowed`,
        );
      }
      await client.query(
        `INSERT INTO oweibo.approval_delegations
           (delegator_user_id, delegate_user_id, tenant_id, action_class, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
         ON CONFLICT (delegator_user_id, delegate_user_id, tenant_id, action_class)
         DO UPDATE SET expires_at = EXCLUDED.expires_at, revoked_at = NULL`,
        [args.delegatorUserId, args.delegateUserId, args.tenantId, args.actionClass, expiresAt],
      );
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async resolvePolicyInTx(
    client: PoolClient,
    tenantId: string,
    actionClass: ActionClass,
  ): Promise<MultiPartyApprovalPolicy> {
    const rows = await client.query<{
      action_class: string;
      quorum: number;
      dissent_vetoes: boolean;
      allow_grants: boolean;
      max_grant_duration_seconds: number;
      max_grant_action_count: number;
      allow_delegation: boolean;
    }>(
      `SELECT action_class, quorum, dissent_vetoes, allow_grants,
              max_grant_duration_seconds, max_grant_action_count, allow_delegation
         FROM oweibo.multi_party_approval_policies
        WHERE tenant_id = $1::uuid AND action_class IN ($2, '*')
        ORDER BY (action_class = $2) DESC
        LIMIT 1`,
      [tenantId, actionClass],
    );
    const row = rows.rows[0];
    if (!row) return platformDefaultMultiPartyPolicy(tenantId, actionClass);
    return {
      tenantId,
      actionClass: row.action_class as ActionClass | '*',
      quorum: row.quorum,
      dissentVetoes: row.dissent_vetoes,
      allowGrants: row.allow_grants,
      maxGrantDurationSeconds: row.max_grant_duration_seconds,
      maxGrantActionCount: row.max_grant_action_count,
      allowDelegation: row.allow_delegation,
    };
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
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
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function defaultEnabled(): boolean {
  return process.env.MULTI_PARTY_APPROVAL_ENABLED === 'true';
}

/**
 * Evaluate a grant's scope_filter against an action payload. A grant with
 * no scope_filter matches everything in its class.
 *
 * Operators:
 *   - eq      : strict deep equality
 *   - in      : `value` is an array; predicate value ∈ array
 *   - matches : `value` is a regex source string; runs against String(predicate)
 */
export function matchesScope(payload: unknown, filter?: GrantScopeFilter): boolean {
  if (!filter) return true;
  const probe = readPath(payload, filter.fieldPath);
  switch (filter.operator) {
    case 'eq':
      return deepEqual(probe, filter.value);
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((v) => deepEqual(probe, v));
    case 'matches':
      if (typeof filter.value !== 'string') return false;
      try {
        return new RegExp(filter.value).test(String(probe ?? ''));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function readPath(obj: unknown, path: string): unknown {
  if (path === '' || path === '.') return obj;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length) return false;
  if (ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

export function tallyToStatus(
  approves: number,
  rejects: number,
  policy: MultiPartyApprovalPolicy,
): QuorumStatus {
  if (policy.dissentVetoes && rejects > 0) {
    return { kind: 'rejected', approves, rejects, quorum: policy.quorum, reason: 'dissent_veto' };
  }
  if (approves >= policy.quorum) {
    return { kind: 'approved', approves, rejects, quorum: policy.quorum };
  }
  return { kind: 'pending', approves, rejects, quorum: policy.quorum };
}
