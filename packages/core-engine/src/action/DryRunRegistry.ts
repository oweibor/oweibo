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
import type { Pool, PoolClient } from 'pg';
import type { GatePrincipal } from '@oweibo/core-contracts';
import { pinViolatesFloor, PinFloorViolationError } from './ActionClassFloor.js';

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

export class DryRunRegistry {
  constructor(private readonly pool: Pool) {}

  /** List proposals visible to the principal's tenant. */
  async list(principal: GatePrincipal, filters: ListFilters = {}): Promise<ProposalSummary[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const states = filters.state && filters.state.length > 0 ? filters.state : ['pending'];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      const params: unknown[] = [states];
      let where = `state = ANY($1::text[])`;
      if (filters.actionClass) {
        params.push(filters.actionClass);
        where += ` AND action_class = $${params.length}`;
      }
      if (filters.beforeCreatedAt) {
        params.push(filters.beforeCreatedAt);
        where += ` AND created_at < $${params.length}::timestamptz`;
      }
      params.push(limit);
      const sql = `
        SELECT id, tenant_id, user_id, action_class, action_id, mode, summary,
               rollback_kind, state, created_at, expires_at, decided_at,
               decided_by, decision_reason
          FROM oweibo.action_proposals
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`;
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows.map(toSummary);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Fetch a single proposal including its full payload and rollback detail. */
  async get(principal: GatePrincipal, proposalId: string): Promise<ProposalDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      const result = await client.query(
        `SELECT id, tenant_id, user_id, action_class, action_id, mode, summary,
                rollback_kind, rollback_detail, payload, state, created_at,
                expires_at, decided_at, decided_by, decision_reason
           FROM oweibo.action_proposals
          WHERE id = $1`,
        [proposalId],
      );
      await client.query('COMMIT');
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return {
        ...toSummary(row),
        payload: row.payload,
        rollbackDetail: row.rollback_detail,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * F.4.3: plan-level proposal detail. Returns the plan row + the
   * count of member action_proposals, or null when the planId is
   * unknown / belongs to another tenant.
   */
  async getPlan(principal: GatePrincipal, planId: string): Promise<PlanDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      const planRes = await client.query(
        `SELECT id, tenant_id, user_id, originating_task_id, title, atomicity,
                state, worst_reversibility, systems, data_domains,
                estimated_cost_usd_cents, estimated_reach_user_count,
                plan_proposal_id, created_at, started_at, completed_at
           FROM oweibo.action_plans
          WHERE id = $1::uuid`,
        [planId],
      );
      if (planRes.rowCount === 0) {
        await client.query('COMMIT');
        return null;
      }
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM oweibo.action_proposals
          WHERE plan_id = $1::uuid`,
        [planId],
      );
      await client.query('COMMIT');
      const row = planRes.rows[0];
      return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        userId: row.user_id ? String(row.user_id) : null,
        originatingTaskId: row.originating_task_id ? String(row.originating_task_id) : null,
        title: String(row.title),
        atomicity: String(row.atomicity),
        state: String(row.state),
        worstReversibility: String(row.worst_reversibility),
        systems: (row.systems ?? []) as string[],
        dataDomains: (row.data_domains ?? []) as string[],
        estimatedCostUsdCents: Number(row.estimated_cost_usd_cents ?? 0),
        estimatedReachUserCount: Number(row.estimated_reach_user_count ?? 0),
        planProposalId: row.plan_proposal_id ? String(row.plan_proposal_id) : null,
        createdAt: toIso(row.created_at) ?? '',
        startedAt: toIso(row.started_at),
        completedAt: toIso(row.completed_at),
        memberCount: Number(countRes.rows[0]?.count ?? 0),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * F.4.3: list every action_proposal that belongs to `planId`.
   * Ordered by created_at ASC so the admin UI renders execution order.
   */
  async listPlanActions(
    principal: GatePrincipal,
    planId: string,
    filters: { limit?: number } = {},
  ): Promise<ProposalSummary[]> {
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      const result = await client.query(
        `SELECT id, tenant_id, user_id, action_class, action_id, mode, summary,
                rollback_kind, state, created_at, expires_at, decided_at,
                decided_by, decision_reason
           FROM oweibo.action_proposals
          WHERE plan_id = $1::uuid
          ORDER BY created_at ASC
          LIMIT $2`,
        [planId, limit],
      );
      await client.query('COMMIT');
      return result.rows.map(toSummary);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Read the per-(tenant, class) trust matrix. Includes only explicit rows. */
  async listTrustMatrix(principal: GatePrincipal): Promise<TrustMatrixRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      const result = await client.query(
        `SELECT action_class, current_mode, pinned_by, pinned_reason,
                observations, successes, rejections, last_updated
           FROM oweibo.tenant_action_class_state
          ORDER BY action_class`,
      );
      await client.query('COMMIT');
      return result.rows.map((r) => ({
        actionClass: r.action_class,
        currentMode: r.current_mode,
        pinnedBy: r.pinned_by,
        pinnedReason: r.pinned_reason,
        observations: r.observations,
        successes: r.successes,
        rejections: r.rejections,
        lastUpdated: typeof r.last_updated === 'string' ? r.last_updated : r.last_updated.toISOString(),
      }));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Pin a class to a specific mode. Pinned classes do not auto-promote. */
  async pin(
    principal: GatePrincipal,
    actionClass: string,
    mode: 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden',
    reason: string,
  ): Promise<void> {
    // Platform floor (write-path guard): a high-risk class
    // (financial/irreversible/personnel-access, plus any
    // ACTION_PIN_FLOOR_CLASSES) may never be pinned to `execute`. The gate's
    // defaults and auto-promotion already respect the floor, but a direct pin
    // previously bypassed it — letting an operator grant standing, unattended
    // authority for e.g. financial.payment. Enforced here so every caller of
    // pin() is covered, not just the HTTP route.
    if (pinViolatesFloor(actionClass, mode)) {
      throw new PinFloorViolationError(actionClass, mode);
    }

    const tenantId = principal.ctx.tenantId ?? '';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      await client.query(
        `INSERT INTO oweibo.tenant_action_class_state (
           tenant_id, action_class, current_mode, pinned_by, pinned_reason, last_updated
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, NOW()
         )
         ON CONFLICT (tenant_id, action_class) DO UPDATE
           SET current_mode  = EXCLUDED.current_mode,
               pinned_by     = EXCLUDED.pinned_by,
               pinned_reason = EXCLUDED.pinned_reason,
               last_updated  = NOW()`,
        [tenantId, actionClass, mode, principal.sub, reason],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Remove an operator pin. State row is preserved so observation counters survive. */
  async unpin(principal: GatePrincipal, actionClass: string): Promise<void> {
    const tenantId = principal.ctx.tenantId ?? '';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, principal);
      await client.query(
        `UPDATE oweibo.tenant_action_class_state
            SET pinned_by = NULL, pinned_reason = NULL, last_updated = NOW()
          WHERE tenant_id = $1::uuid AND action_class = $2`,
        [tenantId, actionClass],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface PlanDetail {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly originatingTaskId: string | null;
  readonly title: string;
  readonly atomicity: string;
  readonly state: string;
  readonly worstReversibility: string;
  readonly systems: readonly string[];
  readonly dataDomains: readonly string[];
  readonly estimatedCostUsdCents: number;
  readonly estimatedReachUserCount: number;
  readonly planProposalId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly memberCount: number;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
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

function toSummary(row: Record<string, unknown>): ProposalSummary {
  const asString = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: asString(row.user_id),
    actionClass: String(row.action_class),
    actionId: String(row.action_id),
    mode: row.mode as ProposalSummary['mode'],
    summary: String(row.summary),
    rollbackKind: (row.rollback_kind as ProposalSummary['rollbackKind']) ?? null,
    state: row.state as ProposalSummary['state'],
    createdAt: asString(row.created_at) ?? '',
    expiresAt: asString(row.expires_at) ?? '',
    decidedAt: asString(row.decided_at),
    decidedBy: asString(row.decided_by),
    decisionReason: asString(row.decision_reason),
  };
}

async function setScope(client: PoolClient, principal: GatePrincipal): Promise<void> {
  const tenantId = principal.ctx.tenantId ?? '';
  if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  }
  if (principal.scopes.includes('platform:tenants:write')) {
    await client.query(`SET LOCAL ROLE platform_admin`);
  }
}
