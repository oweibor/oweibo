/**
 * withTenantScope — single source of truth for opening a transaction
 * scoped to a tenant (or to platform_admin for cross-tenant reads).
 *
 * Background: F.5 audit (2026-05-30 review) found three places where
 * `SET LOCAL ROLE platform_admin` was issued OUTSIDE a transaction:
 *
 *   1. PgOrgGraphSeederAdapter.findCreatingUser
 *   2. apps/tenant-bootstrap-worker/src/index.ts:reconcile()
 *   3. apps/tenant-bootstrap-worker/src/BootstrapWorker.loadHomeRegion
 *
 * Postgres treats SET LOCAL outside a transaction as a no-op (silently),
 * so the intended RLS-bypass / scope-setting never took effect. Six
 * other adapters (PgConnectorRecommender, PgGoalTemplateAcknowledger,
 * PgBanditPriorsSeeder, PgOntologyPackInstaller, PgProjectSeeder,
 * PgDomainIntakeProcessor) had their own correct copy of the same
 * pattern; PgTenantCloner had a near-clone (txPlatform). This helper
 * unifies all of them on one implementation so a future hardening
 * change (e.g. `SET LOCAL statement_timeout`) only edits one place.
 *
 * Contract:
 *   - Always opens a BEGIN/COMMIT (or ROLLBACK on throw).
 *   - When `tenantId` is a UUID, sets `app.tenant_id` GUC + role
 *     `platform_admin`. The role line is fail-quiet (`.catch`) so
 *     tests that don't grant the role to `oweibo_app` still work.
 *   - When `tenantId === null`, sets ONLY the platform_admin role —
 *     used for cross-tenant operations (e.g. PgTenantCloner copying
 *     between two tenants).
 *
 * Tenant-id is validated against a UUID regex BEFORE interpolation;
 * the regex match is the security boundary. Parameterising
 * `app.tenant_id` is not possible because SET LOCAL doesn't accept
 * bind parameters.
 */
import type { Pool, PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenantScope<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (tenantId !== null && !UUID_RE.test(tenantId)) {
    throw new Error(`withTenantScope: invalid tenant id format: ${JSON.stringify(tenantId)}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      // SET LOCAL is per-transaction; safe inside the BEGIN.
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    }
    await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
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
