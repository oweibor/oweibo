/**
 * RLS belt-and-suspenders test suite.
 *
 * These tests verify that Postgres RLS alone (with application-layer tenant
 * checks bypassed via test flag) correctly blocks cross-tenant access.
 *
 * Prerequisites:
 *   - TEST_DATABASE_URL points to a Postgres instance with migrations applied
 *   - oweibo_app role exists and matches DATABASE_URL credentials
 *
 * Run: pnpm --filter @oweibo/db test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];

// Skip the whole suite if no test database is configured (CI without Postgres)
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('RLS belt-and-suspenders', () => {
  let db: PrismaClient;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });

    // Seed two tenants under platform_admin. Since migration 000015 the
    // tenants bypass policy requires CURRENT_USER = 'platform_admin' (not the
    // GUC), so a plain oweibo_app connection cannot insert directly — and the
    // suite must connect as oweibo_app or RLS would not bind at all.
    const seeded = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE platform_admin`);
      const a = await tx.$queryRaw<[{ id: string }]>`
        INSERT INTO oweibo.tenants (name, slug, quotas)
        VALUES ('Tenant A', 'tenant-a-rls-test', '{}')
        RETURNING id
      `;
      const b = await tx.$queryRaw<[{ id: string }]>`
        INSERT INTO oweibo.tenants (name, slug, quotas)
        VALUES ('Tenant B', 'tenant-b-rls-test', '{}')
        RETURNING id
      `;
      return { a: (a[0] as { id: string }).id, b: (b[0] as { id: string }).id };
    });
    tenantAId = seeded.a;
    tenantBId = seeded.b;
  });

  afterAll(async () => {
    // Clean up test tenants (platform_admin — same reason as beforeAll)
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE platform_admin`);
      await tx.$executeRaw`DELETE FROM oweibo.tenants WHERE slug IN ('tenant-a-rls-test','tenant-b-rls-test')`;
    });
    await db.$disconnect();
  });

  it('cross-tenant SELECT is blocked by RLS when app.is_platform_admin is not set', async () => {
    // Set app.tenant_id to tenant A — should not see tenant B rows
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
      return tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM oweibo.tenants WHERE id = ${tenantBId}::uuid
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it('the app.is_platform_admin GUC does NOT bypass RLS (000015 hardening)', async () => {
    // Pre-000015 this GUC granted bypass — which any oweibo_app transaction
    // could SET LOCAL, making it a privilege-escalation hole. 000015 replaced
    // it with a role check. The original version of this test asserted the
    // GUC bypass WORKED, i.e. it asserted the vulnerability (found 2026-07-10
    // when the suite first ran against a post-000015 database).
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.is_platform_admin = 'true'`);
      return tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM oweibo.tenants WHERE id = ${tenantBId}::uuid
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it('SET LOCAL ROLE platform_admin allows cross-tenant SELECT (the sanctioned bypass)', async () => {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE platform_admin`);
      return tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM oweibo.tenants WHERE id = ${tenantBId}::uuid
      `;
    });
    expect(rows).toHaveLength(1);
  });

  it('audit_log UPDATE is rejected regardless of RLS settings', async () => {
    await expect(
      db.$executeRaw`
        UPDATE oweibo.audit_log SET action = 'tampered' WHERE 1=1
      `,
    ).rejects.toThrow();
  });

  it('audit_log DELETE is rejected regardless of RLS settings', async () => {
    await expect(
      db.$executeRaw`
        DELETE FROM oweibo.audit_log WHERE 1=1
      `,
    ).rejects.toThrow();
  });

  it('app.tenant_id does not leak across transaction boundaries (SET LOCAL)', async () => {
    // First transaction sets tenant A
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
    });
    // Second transaction — no SET LOCAL — should see no tenant_id
    const rows = await db.$transaction(async (tx) => {
      return tx.$queryRaw<{ current_setting: string }[]>`
        SELECT current_setting('app.tenant_id', true) AS current_setting
      `;
    });
    const value = (rows[0] as { current_setting: string } | undefined)?.current_setting ?? '';
    expect(value).not.toBe(tenantAId);
  });
});
