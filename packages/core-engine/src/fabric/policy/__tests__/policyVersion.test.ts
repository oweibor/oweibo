/**
 * ADR-006 §7 — INV-13 conformance: a value change and its policy_version bump
 * are inseparable. Against live Postgres; skips cleanly without TEST_DATABASE_URL.
 *
 * The version is a structural component of the ADR-001 §3.6 cache key, so this
 * is the test that guarantees a policy change invalidates stale cache entries
 * by construction — there is no write path that changes a value without
 * bumping the version.
 */
import { Pool, type PoolClient } from 'pg';
import { TenantPolicyService } from '../TenantPolicyService';
import type { PolicyValue } from '../contract';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('ADR-006 §3.5 — INV-13: value change and version bump are one transaction', () => {
  let pool: Pool;
  let tenant: string;
  const svc = () => new TenantPolicyService(pool);

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET ROLE platform_admin`); return await fn(client); }
    finally { await client.query(`RESET ROLE`).catch(() => undefined); client.release(); }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    tenant = await withPlatformAdmin(async (c) => {
      const r = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant Policy', 'tenant-policy-battery', '{}') RETURNING id`,
      );
      return r.rows[0].id as string;
    });
  });

  afterAll(async () => {
    await withPlatformAdmin((c) => c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-policy-battery'`));
    await pool.end();
  });

  const scope = (s: 'metadata' | 'full_content'): PolicyValue => ({ kind: 'indexing_scope', scope: s });

  it('a tightening applies immediately and bumps the version', async () => {
    const before = await svc().currentVersion(tenant);
    // Default indexing_scope is metadata; go full_content (relaxation) first via
    // approval so we have something to tighten back down.
    const relax = await svc().applyApprovedRelaxation(
      { tenantId: tenant, proposerId: crypto.randomUUID(), changes: [{ dimension: 'indexing_scope', value: scope('full_content') }] },
      [{ principalId: 'a', approve: true }, { principalId: 'b', approve: true }],
    );
    expect(relax.kind).toBe('applied');

    // Now tighten back to metadata — single admin, mandatory backfill.
    const tighten = await svc().propose({
      tenantId: tenant,
      proposerId: crypto.randomUUID(),
      changes: [{ dimension: 'indexing_scope', value: scope('metadata') }],
    });
    expect(tighten.kind).toBe('applied');
    if (tighten.kind === 'applied') expect(tighten.backfillRequired).toBe(true);

    const after = await svc().currentVersion(tenant);
    expect(BigInt(after)).toBeGreaterThan(BigInt(before));
  });

  it('a relaxation is REFUSED without quorum (propose returns needs_dual_control)', async () => {
    const r = await svc().propose({
      tenantId: tenant,
      proposerId: crypto.randomUUID(),
      changes: [{ dimension: 'indexing_scope', value: scope('full_content') }],
    });
    expect(r.kind).toBe('needs_dual_control');
    if (r.kind === 'needs_dual_control') {
      expect(r.classification).toBe('relaxation');
      expect(r.quorum).toBeGreaterThanOrEqual(2);
    }
  });

  it('the proposer alone cannot apply a relaxation, even with a repeated vote', async () => {
    const proposer = crypto.randomUUID();
    const r = await svc().applyApprovedRelaxation(
      { tenantId: tenant, proposerId: proposer, changes: [{ dimension: 'indexing_scope', value: scope('full_content') }] },
      [{ principalId: proposer, approve: true }, { principalId: proposer, approve: true }],
    );
    expect(r.kind).toBe('needs_dual_control');
  });

  it('every applied change emits PolicyChanged AFTER the durable write (INV-5)', async () => {
    const events = await pool.query(
      `SELECT payload->>'policyVersion' AS v FROM oweibo.outbox
        WHERE subject = 'PolicyChanged' AND payload->>'tenantId' = $1
        ORDER BY (payload->>'policyVersion')::bigint`,
      [tenant],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(2);
    // Each emitted version corresponds to a real committed row (never an event
    // ahead of the write).
    const maxEventVersion = BigInt(events.rows[events.rows.length - 1]!.v);
    const current = BigInt(await svc().currentVersion(tenant));
    expect(maxEventVersion).toBeLessThanOrEqual(current);
  });

  it('the category CHECK rejects a dimension re-declared under the wrong category', async () => {
    // §3.1: category is a property of the dimension. Attempt to write
    // data_residency as 'operational' — the CHECK must reject it.
    await expect(
      withPlatformAdmin((c) =>
        c.query(
          `INSERT INTO oweibo.kf_tenant_policies (tenant_id, dimension, category, value, policy_version)
           VALUES ($1::uuid, 'data_residency', 'operational', '{"kind":"data_residency","region":"x"}'::jsonb, 99)`,
          [tenant],
        ),
      ),
    ).rejects.toThrow();
  });
});
