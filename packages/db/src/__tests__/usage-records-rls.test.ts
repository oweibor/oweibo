/**
 * usage_records RLS + SECURITY DEFINER aggregation tests.
 *
 * Verifies:
 *   1. Tenant A under SET LOCAL app.tenant_id=A sees only A's rows
 *   2. INSERT WITH CHECK rejects rows whose tenant_id ≠ app.tenant_id
 *   3. SET LOCAL ROLE platform_admin sees every tenant's rows
 *   4. oweibo.usage_records_aggregate() rolls up across tenants (callable
 *      only from platform_admin context due to EXECUTE grant)
 *
 * Prerequisites:
 *   - TEST_DATABASE_URL configured
 *   - Migration 20260519_000015_platform_admin_role_rls_lockdown.sql applied
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('usage_records RLS lockdown', () => {
  let pool: Pool;
  let tenantAId: string;
  let tenantBId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });

    // Seed two tenants via platform_admin (tenants table has no tenant_isolation policy).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      const a = await client.query<{ id: string }>(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant A usage', $1, '{}') RETURNING id`,
        [`tenant-a-usage-${suffix}`],
      );
      const b = await client.query<{ id: string }>(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant B usage', $1, '{}') RETURNING id`,
        [`tenant-b-usage-${suffix}`],
      );
      tenantAId = a.rows[0]!.id;
      tenantBId = b.rows[0]!.id;

      // Seed one usage row for each tenant.
      for (const [tid, cost] of [[tenantAId, '0.10'], [tenantBId, '0.20']] as const) {
        await client.query(
          `INSERT INTO oweibo.usage_records
             (tenant_id, record_type, quantity, unit, cost_usd, billed, recorded_at)
           VALUES ($1, 'distillation', 1, 'call', $2, false, NOW())`,
          [tid, cost],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      await client.query(
        `DELETE FROM oweibo.usage_records WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        [tenantAId, tenantBId],
      );
      await client.query(
        `DELETE FROM oweibo.tenants WHERE id IN ($1::uuid, $2::uuid)`,
        [tenantAId, tenantBId],
      );
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await pool.end();
  });

  it('oweibo_app cannot SELECT raw usage rows at all — even under its own tenant context', async () => {
    // Design decision in migration 000015, stated verbatim there: "No SELECT
    // grant — tenants do not read raw usage rows; cross-tenant rollups go
    // through the SECURITY DEFINER aggregation function." The original
    // version of this test asserted tenant-scoped SELECT worked, which
    // contradicts the very migration this suite is named after (found
    // 2026-07-10 when the suite first ran against a live migrated DB).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantAId]);
      await expect(
        client.query(
          `SELECT tenant_id FROM oweibo.usage_records WHERE tenant_id IN ($1::uuid, $2::uuid)`,
          [tenantAId, tenantBId],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      // The failed statement leaves the transaction aborted — roll back
      // before releasing so the pooled connection is not poisoned for the
      // next test.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('INSERT with mismatched tenant_id is rejected by WITH CHECK', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantAId]);
      // Try to insert a row attributed to tenant B while operating as tenant A.
      await expect(
        client.query(
          `INSERT INTO oweibo.usage_records
             (tenant_id, record_type, quantity, unit, cost_usd, billed)
           VALUES ($1::uuid, 'distillation', 1, 'call', 0.99, false)`,
          [tenantBId],
        ),
      ).rejects.toThrow(/row-level security|violates/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('SET LOCAL ROLE platform_admin sees every tenant row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      const result = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM oweibo.usage_records WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        [tenantAId, tenantBId],
      );
      await client.query('COMMIT');
      const ids = result.rows.map((r: { tenant_id: string }) => r.tenant_id).sort();
      expect(ids).toEqual([tenantAId, tenantBId].sort());
    } finally {
      client.release();
    }
  });

  it('usage_records_aggregate is not callable from a plain oweibo_app session', async () => {
    // No SET LOCAL ROLE — EXECUTE is granted only to platform_admin, and
    // oweibo_app holds membership WITH INHERIT FALSE, so it must not inherit.
    await expect(
      pool.query(
        `SELECT * FROM oweibo.usage_records_aggregate(
           NOW() - interval '1 day', NOW() + interval '1 day'
         )`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('task_tenant returns the task\'s authenticated tenant from an oweibo_app session', async () => {
    // Seed a task as platform_admin (RLS-protected; needs bypass to insert as a different tenant)
    const client = await pool.connect();
    let taskId: string;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      const r = await client.query<{ id: string }>(
        `INSERT INTO oweibo.tasks (tenant_id, goal_description)
         VALUES ($1::uuid, 'tenant-provenance fixture')
         RETURNING id`,
        [tenantAId],
      );
      taskId = r.rows[0]!.id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    try {
      // No SET LOCAL ROLE, no app.tenant_id — function must still return the
      // tenant_id (SECURITY DEFINER bypasses RLS internally).
      const r = await pool.query<{ tenant_id: string | null }>(
        `SELECT oweibo.task_tenant($1::uuid) AS tenant_id`,
        [taskId],
      );
      expect(r.rows[0]!.tenant_id).toBe(tenantAId);

      // Unknown task returns NULL — caller treats as "skip".
      const r2 = await pool.query<{ tenant_id: string | null }>(
        `SELECT oweibo.task_tenant('00000000-0000-0000-0000-000000000000'::uuid) AS tenant_id`,
      );
      expect(r2.rows[0]!.tenant_id).toBeNull();
    } finally {
      // Clean up the seeded task
      const cleanup = await pool.connect();
      try {
        await cleanup.query('BEGIN');
        await cleanup.query('SET LOCAL ROLE platform_admin');
        await cleanup.query(`DELETE FROM oweibo.tasks WHERE id = $1::uuid`, [taskId]);
        await cleanup.query('COMMIT');
      } catch { await cleanup.query('ROLLBACK'); }
      finally { cleanup.release(); }
    }
  });

  it('append_audit retains correct behavior with search_path pinned', async () => {
    // Sanity: the search_path-pinned re-definition still inserts a row.
    // Read-back uses platform_admin since audit_log SELECT is RLS-protected.
    const idResult = await pool.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`);
    const id = idResult.rows[0]!.id;
    await pool.query(
      `SELECT oweibo.append_audit(
         $1::uuid, NOW(), 'test:append_audit', NULL, 'system', NULL, NULL,
         $2::uuid, ARRAY['platform:test'], 'test.search_path_pin',
         NULL, NULL, NULL, NULL, 'allow', NULL
       )`,
      [id, tenantAId],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oweibo.audit_log WHERE id = $1::uuid`,
        [id],
      );
      await client.query('COMMIT');
      expect(Number(r.rows[0]!.count)).toBe(1);
    } finally {
      client.release();
    }
  });

  it('usage_records_aggregate under platform_admin rolls up across tenants', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      const result = await client.query<{
        tenant_id: string;
        record_type: string;
        total_cost_usd: string;
        call_count: string;
      }>(
        `SELECT tenant_id, record_type, total_cost_usd, call_count
           FROM oweibo.usage_records_aggregate(
             NOW() - interval '1 day', NOW() + interval '1 day', 'distillation'
           )
         WHERE tenant_id IN ($1::uuid, $2::uuid)
         ORDER BY total_cost_usd`,
        [tenantAId, tenantBId],
      );
      await client.query('COMMIT');
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]!.tenant_id).toBe(tenantAId);
      expect(result.rows[1]!.tenant_id).toBe(tenantBId);
      expect(Number(result.rows[0]!.total_cost_usd)).toBeCloseTo(0.10);
      expect(Number(result.rows[1]!.total_cost_usd)).toBeCloseTo(0.20);
    } finally {
      client.release();
    }
  });
});
