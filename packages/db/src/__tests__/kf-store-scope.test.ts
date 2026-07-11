/**
 * Knowledge-fabric store-scope conformance suite (ADR-000, INV-12).
 *
 * Every fabric table is declared exactly one of:
 *   - tenant-scoped:   FORCE ROW LEVEL SECURITY + a `tenant_isolation` policy
 *                      on app.tenant_id (the tenant_connectors shape)
 *   - platform-scoped: no tenant data; justification lives in the migration
 *                      header (the processed_outbox_events precedent)
 *
 * This manifest is the living INV-12 registry: one entry PER TABLE, never per
 * migration file (kf_revision_acl_membership.sql alone contributes three).
 * K.0 adds all eight kf_* tables to TENANT_SCOPED when their migrations land.
 *
 * Prerequisites:
 *   - TEST_DATABASE_URL points to a Postgres instance with migrations applied
 *
 * Run: pnpm --filter @oweibo/db test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];

// Skip the whole suite if no test database is configured (CI without Postgres)
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

/**
 * The fabric store-scope manifest (ADR-000 §3.3).
 *
 * K.0 armed (2026-07-10, per ratified schema chapters ADR-003/010/007 and
 * ADR-013 §3.1): all eight kf_* tables registered — entry per TABLE, never
 * per migration file.
 */
const TENANT_SCOPED: string[] = [
  'tenant_connectors',
  // ADR-003 schema chapter
  'kf_knowledge_objects',
  'kf_chunks',
  'kf_revision_vectors',
  // ADR-010 schema chapter
  'kf_acl_snapshots',
  'kf_membership_records',
  // ADR-007 schema chapter
  'kf_provenance',
  // ADR-013 §3.1
  'kf_jobs',
  'kf_leases',
];

const PLATFORM_SCOPED: string[] = ['processed_outbox_events'];

describeOrSkip('kf store-scope conformance (INV-12)', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  describe('tenant-scoped tables have forced RLS with a tenant_isolation policy', () => {
    for (const table of TENANT_SCOPED) {
      it(`oweibo.${table} has RLS enabled AND forced`, async () => {
        const rows = await db.$queryRaw<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >`
          SELECT c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'oweibo' AND c.relname = ${table}
        `;
        expect(rows, `oweibo.${table} not found — manifest names a missing table`).toHaveLength(1);
        expect(rows[0]!.relrowsecurity, `RLS not enabled on oweibo.${table}`).toBe(true);
        expect(rows[0]!.relforcerowsecurity, `RLS not FORCED on oweibo.${table}`).toBe(true);
      });

      it(`oweibo.${table} has a tenant_isolation policy on app.tenant_id`, async () => {
        const rows = await db.$queryRaw<{ qual: string | null }[]>`
          SELECT qual
          FROM pg_policies
          WHERE schemaname = 'oweibo' AND tablename = ${table} AND policyname = 'tenant_isolation'
        `;
        expect(rows, `no tenant_isolation policy on oweibo.${table}`).toHaveLength(1);
        expect(rows[0]!.qual ?? '').toContain('app.tenant_id');
      });
    }
  });

  describe('platform-scoped tables carry no tenant data', () => {
    for (const table of PLATFORM_SCOPED) {
      it(`oweibo.${table} exists and has no tenant_id column`, async () => {
        const exists = await db.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS count
          FROM information_schema.tables
          WHERE table_schema = 'oweibo' AND table_name = ${table}
        `;
        expect(Number(exists[0]!.count), `oweibo.${table} not found`).toBe(1);

        const tenantCol = await db.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS count
          FROM information_schema.columns
          WHERE table_schema = 'oweibo' AND table_name = ${table} AND column_name = 'tenant_id'
        `;
        expect(
          Number(tenantCol[0]!.count),
          `oweibo.${table} is declared platform-scoped but has a tenant_id column`,
        ).toBe(0);
      });
    }
  });

  describe('two-tenant cross-access proof on tenant_connectors', () => {
    let tenantAId: string;
    let tenantBId: string;

    beforeAll(async () => {
      // oweibo.tenants' bypass policy requires CURRENT_USER = 'platform_admin'
      // (hardened in migration 000015); oweibo_app is a member of that role.
      // Seed tenants under that escalation — the isolation assertions below
      // run under plain tenant context so RLS binds.
      const seeded = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE platform_admin`);
        const a = await tx.$queryRaw<[{ id: string }]>`
          INSERT INTO oweibo.tenants (name, slug, quotas)
          VALUES ('Tenant A', 'tenant-a-kf-scope-test', '{}') RETURNING id
        `;
        const b = await tx.$queryRaw<[{ id: string }]>`
          INSERT INTO oweibo.tenants (name, slug, quotas)
          VALUES ('Tenant B', 'tenant-b-kf-scope-test', '{}') RETURNING id
        `;
        return { a: a[0].id, b: b[0].id };
      });
      tenantAId = seeded.a;
      tenantBId = seeded.b;

      // Insert tenant B's connector instance inside B's tenant context so the
      // write passes RLS regardless of the test role's privileges.
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantBId}'`);
        await tx.$executeRaw`
          INSERT INTO oweibo.tenant_connectors
            (tenant_id, connector_id, catalog_version, instance_label, vault_path)
          VALUES
            (${tenantBId}::uuid, 'github', 'kf-scope-test', 'kf-scope-test',
             'oweibo/tenants/kf-scope-test/connectors/github/kf-scope-test')
        `;
      });
    });

    afterAll(async () => {
      // Tenant delete cascades to tenant_connectors (ON DELETE CASCADE).
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE platform_admin`);
        await tx.$executeRaw`
          DELETE FROM oweibo.tenants
          WHERE slug IN ('tenant-a-kf-scope-test', 'tenant-b-kf-scope-test')
        `;
      });
    });

    it("tenant A cannot read tenant B's connector rows", async () => {
      const rows = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM oweibo.tenant_connectors WHERE tenant_id = ${tenantBId}::uuid
        `;
      });
      expect(rows).toHaveLength(0);
    });

    it('tenant B sees its own connector row', async () => {
      const rows = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantBId}'`);
        return tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM oweibo.tenant_connectors WHERE tenant_id = ${tenantBId}::uuid
        `;
      });
      expect(rows).toHaveLength(1);
    });
  });
});
