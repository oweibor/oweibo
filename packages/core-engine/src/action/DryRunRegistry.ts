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
