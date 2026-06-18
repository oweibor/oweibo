/**
 * F.1.5 — PgOrgGraphReader.
 *
 * Production implementation of IOrgGraphReader (declared in EscalationEngine).
 *
 * `resolveApprovers(tenantId, actionClass)`
 *   Looks up the initial approver set by joining
 *     oweibo.tenant_action_approver_routing  (per-(tenant, class) → org_node ids)
 *     oweibo.org_nodes
 *   The routing table is planned for T.2.h but not yet shipped; until it
 *   exists, the resolver catches `42P01 undefined_table` and returns
 *   `fromGraph: false` so the EscalationEngine falls back to the role-based
 *   path (already implemented). The fallback is the working behaviour today.
 *
 *   When the routing table exists but no rows match (tenant.class), the
 *   resolver also returns `fromGraph: false`. When rows match but resolve
 *   to zero non-deleted users, returns `fromGraph: true, users: []` — the
 *   engine treats that as a chain-exhausted state and surfaces the warning.
 *
 * `reportsTo(tenantId, nodeIds)`
 *   Walks `org_edges WHERE edge_type='reports_to'` exactly one level up
 *   from each input node. The engine drives multi-level escalation by
 *   calling reportsTo() once per stage; this is intentional (the FSM
 *   already paces the escalation per the policy's escalateAfterSeconds
 *   array) so we do NOT recurse here.
 *
 * Tenant scoping: every query runs inside a transaction with
 * `SET LOCAL app.tenant_id`; RLS guarantees no cross-tenant rows leak.
 */
import type { Pool, PoolClient } from 'pg';
import type { IOrgGraphReader } from './EscalationEngine.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const UNDEFINED_TABLE = '42P01';

export class PgOrgGraphReader implements IOrgGraphReader {
  constructor(private readonly pool: Pool) {}

  async resolveApprovers(tenantId: string, actionClass: string): Promise<{
    readonly nodes: readonly string[];
    readonly users: readonly string[];
    readonly fromGraph: boolean;
  }> {
    if (!UUID_RE.test(tenantId)) {
      return { nodes: [], users: [], fromGraph: false };
    }
    return withTenantClient(this.pool, tenantId, async (client) => {
      let r;
      try {
        r = await client.query<{ node_id: string; user_id: string | null }>(
          `SELECT n.id AS node_id, n.user_id
             FROM oweibo.tenant_action_approver_routing r
             JOIN oweibo.org_nodes n
               ON n.id = r.node_id
              AND n.tenant_id = r.tenant_id
            WHERE r.tenant_id    = $1::uuid
              AND r.action_class = $2
              AND r.enabled      = TRUE`,
          [tenantId, actionClass],
        );
      } catch (err) {
        // Table not yet shipped (T.2.h follow-up) → fall through to role-based
        // routing. Any other error propagates.
        if ((err as { code?: string }).code === UNDEFINED_TABLE) {
          return { nodes: [], users: [], fromGraph: false };
        }
        throw err;
      }
      if (r.rows.length === 0) {
        return { nodes: [], users: [], fromGraph: false };
      }
      const nodes: string[] = [];
      const users: string[] = [];
      for (const row of r.rows) {
        nodes.push(row.node_id);
        if (row.user_id) users.push(row.user_id);
      }
      return { nodes: dedupe(nodes), users: dedupe(users), fromGraph: true };
    });
  }

  async reportsTo(tenantId: string, nodeIds: readonly string[]): Promise<{
    readonly nodes: readonly string[];
    readonly users: readonly string[];
  }> {
    if (!UUID_RE.test(tenantId) || nodeIds.length === 0) {
      return { nodes: [], users: [] };
    }
    return withTenantClient(this.pool, tenantId, async (client) => {
      const r = await client.query<{ id: string; user_id: string | null }>(
        `SELECT n.id, n.user_id
           FROM oweibo.org_nodes n
           JOIN oweibo.org_edges e
             ON e.tenant_id = n.tenant_id
            AND e.to_node   = n.id
            AND e.edge_type = 'reports_to'
          WHERE n.tenant_id = $1::uuid
            AND e.from_node = ANY($2::uuid[])`,
        [tenantId, nodeIds],
      );
      const nodes: string[] = [];
      const users: string[] = [];
      for (const row of r.rows) {
        nodes.push(row.id);
        if (row.user_id) users.push(row.user_id);
      }
      return { nodes: dedupe(nodes), users: dedupe(users) };
    });
  }
}

async function withTenantClient<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
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

function dedupe(xs: readonly string[]): readonly string[] {
  return Array.from(new Set(xs));
}
