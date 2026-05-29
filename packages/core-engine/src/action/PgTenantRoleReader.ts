/**
 * F.1.5 — PgTenantRoleReader.
 *
 * Production implementation of ITenantRoleReader (declared in
 * EscalationEngine). Used by the role-based escalation path and as the
 * fallback when the org-graph routing table is empty.
 *
 * `usersWithRoles(tenantId, roles)`
 *   Returns DISTINCT user_ids whose `roles` array intersects the requested
 *   role set. Tenant-scoped via SET LOCAL app.tenant_id; RLS guarantees no
 *   cross-tenant leak.
 *
 * Note on tenant_memberships:
 *   The plan referenced a `WHERE deleted_at IS NULL` filter on the
 *   membership row. The current schema does not carry a deleted_at column
 *   (memberships are hard-deleted), so no soft-delete filter is needed.
 *   If that schema evolves, this query must be updated in lockstep.
 */
import type { Pool, PoolClient } from 'pg';
import type { ITenantRoleReader } from './EscalationEngine.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;

export class PgTenantRoleReader implements ITenantRoleReader {
  constructor(private readonly pool: Pool) {}

  async usersWithRoles(tenantId: string, roles: readonly string[]): Promise<readonly string[]> {
    if (!UUID_RE.test(tenantId) || roles.length === 0) return [];
    return withTenantClient(this.pool, tenantId, async (client) => {
      const r = await client.query<{ user_id: string }>(
        `SELECT DISTINCT user_id
           FROM oweibo.tenant_memberships
          WHERE tenant_id = $1::uuid
            AND roles && $2::text[]`,
        [tenantId, roles],
      );
      return r.rows.map((row) => row.user_id);
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
