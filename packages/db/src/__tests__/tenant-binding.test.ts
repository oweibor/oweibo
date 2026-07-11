/**
 * Tenant-binding check tests for withTenantContext.
 *
 * Verifies the JWT-claim → DB-state cross-check we added to catch stale
 * tokens, revoked memberships, and forged claims.
 *
 * Prerequisites:
 *   - TEST_DATABASE_URL configured
 *   - All migrations applied (through 20260519_000018_tenant_binding_lookup.sql)
 */
import './test-env.js'; // MUST precede withTenantContext (hoisted PrismaClient reads DATABASE_URL)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  withTenantContext,
  TenantBindingError,
  _clearTenantBindingCache,
} from '../withTenantContext.js';
import type { Principal } from '../types.js';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

describeOrSkip('withTenantContext: tenant-binding enforcement', () => {
  let pool: Pool;
  let tenantAId: string;
  let tenantBId: string;
  let userMemberOfAId: string;
  let userNoMemberId: string;
  let validKeyId: string;
  let revokedKeyId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');

      // Two tenants
      const a = await client.query<{ id: string }>(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant A binding', $1, '{}') RETURNING id`,
        [`tenant-a-binding-${suffix}`],
      );
      const b = await client.query<{ id: string }>(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant B binding', $1, '{}') RETURNING id`,
        [`tenant-b-binding-${suffix}`],
      );
      tenantAId = a.rows[0]!.id;
      tenantBId = b.rows[0]!.id;

      // Two users — one with a membership in A, one with no memberships
      const u1 = await client.query<{ id: string }>(
        `INSERT INTO oweibo.users (id, email, status)
         VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
        [`member-${suffix}@test.local`],
      );
      const u2 = await client.query<{ id: string }>(
        `INSERT INTO oweibo.users (id, email, status)
         VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
        [`outsider-${suffix}@test.local`],
      );
      userMemberOfAId = u1.rows[0]!.id;
      userNoMemberId  = u2.rows[0]!.id;

      await client.query(
        `INSERT INTO oweibo.tenant_memberships (user_id, tenant_id, roles)
         VALUES ($1::uuid, $2::uuid, ARRAY['tenant_developer'])`,
        [userMemberOfAId, tenantAId],
      );

      // A valid api-key and a revoked one, both bound to tenant A.
      const k1 = await client.query<{ id: string }>(
        `INSERT INTO oweibo.api_keys
           (tenant_id, created_by_user_id, name, prefix, hashed_secret, scopes)
         VALUES ($1::uuid, $2::uuid, 'valid', 'oweibo_ak_', 'x', ARRAY['tasks:write'])
         RETURNING id`,
        [tenantAId, userMemberOfAId],
      );
      const k2 = await client.query<{ id: string }>(
        `INSERT INTO oweibo.api_keys
           (tenant_id, created_by_user_id, name, prefix, hashed_secret, scopes, revoked_at)
         VALUES ($1::uuid, $2::uuid, 'revoked', 'oweibo_ak_', 'x', ARRAY['tasks:write'], NOW())
         RETURNING id`,
        [tenantAId, userMemberOfAId],
      );
      validKeyId   = k1.rows[0]!.id;
      revokedKeyId = k2.rows[0]!.id;

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
      await client.query(`DELETE FROM oweibo.api_keys WHERE id IN ($1::uuid, $2::uuid)`, [validKeyId, revokedKeyId]);
      await client.query(`DELETE FROM oweibo.tenant_memberships WHERE user_id IN ($1::uuid, $2::uuid)`, [userMemberOfAId, userNoMemberId]);
      await client.query(`DELETE FROM oweibo.users WHERE id IN ($1::uuid, $2::uuid)`, [userMemberOfAId, userNoMemberId]);
      await client.query(`DELETE FROM oweibo.tenants WHERE id IN ($1::uuid, $2::uuid)`, [tenantAId, tenantBId]);
      await client.query('COMMIT');
    } catch { await client.query('ROLLBACK'); }
    finally { client.release(); }
    await pool.end();
  });

  beforeEach(() => {
    _clearTenantBindingCache();
  });

  function userPrincipal(userId: string, tenantId: string): Principal {
    return {
      sub: userId,
      kind: 'user',
      scopes: ['tasks:read'],
      ctx: { tenantId },
    };
  }

  function apiKeyPrincipal(keyId: string, tenantId: string): Principal {
    return {
      sub: `apikey:${keyId}`,
      kind: 'api_key',
      scopes: ['tasks:read'],
      ctx: { tenantId },
    };
  }

  function agentPrincipal(
    runId: string,
    actAsUser: string,
    actAsTenant: string,
    ctxTenant: string,
  ): Principal {
    return {
      sub: `agent:${runId}`,
      kind: 'agent',
      scopes: ['tasks:read'],
      ctx: { tenantId: ctxTenant },
      actAs: { sub: actAsUser, tenantId: actAsTenant },
    };
  }

  it('user with active membership passes', async () => {
    const result = await withTenantContext(
      userPrincipal(userMemberOfAId, tenantAId),
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });

  it('user without membership is rejected with TenantBindingError', async () => {
    await expect(
      withTenantContext(userPrincipal(userNoMemberId, tenantAId), async () => 'never'),
    ).rejects.toBeInstanceOf(TenantBindingError);
  });

  it('user with membership in A cannot claim tenant B', async () => {
    await expect(
      withTenantContext(userPrincipal(userMemberOfAId, tenantBId), async () => 'never'),
    ).rejects.toBeInstanceOf(TenantBindingError);
  });

  it('platform-admin scope skips the binding check', async () => {
    const principal: Principal = {
      sub: userNoMemberId,
      kind: 'user',
      // platform:tenants:write is the scope that unlocks the platform_admin role
      scopes: ['platform:tenants:write'],
      ctx: { tenantId: tenantAId },
    };
    // Even though userNoMember has no membership, platform-admin bypasses.
    const result = await withTenantContext(principal, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('valid api-key bound to its tenant passes', async () => {
    const result = await withTenantContext(
      apiKeyPrincipal(validKeyId, tenantAId),
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });

  it('revoked api-key is rejected', async () => {
    await expect(
      withTenantContext(apiKeyPrincipal(revokedKeyId, tenantAId), async () => 'never'),
    ).rejects.toBeInstanceOf(TenantBindingError);
  });

  it('api-key bound to tenant A cannot claim tenant B', async () => {
    await expect(
      withTenantContext(apiKeyPrincipal(validKeyId, tenantBId), async () => 'never'),
    ).rejects.toBeInstanceOf(TenantBindingError);
  });

  it('agent token requires actAs membership in the claimed tenant', async () => {
    // actAs user has membership in A — agent claiming tenant A should pass
    const ok = await withTenantContext(
      agentPrincipal('run-1', userMemberOfAId, tenantAId, tenantAId),
      async () => 'ok',
    );
    expect(ok).toBe('ok');

    // actAs user has no membership in B — agent claiming B should fail
    await expect(
      withTenantContext(
        agentPrincipal('run-2', userMemberOfAId, tenantBId, tenantBId),
        async () => 'never',
      ),
    ).rejects.toBeInstanceOf(TenantBindingError);
  });

  it('agent token with inconsistent actAs.tenantId vs ctx.tenantId is rejected', async () => {
    // ctx claims A, actAs claims B — tampered/inconsistent token
    await expect(
      withTenantContext(
        agentPrincipal('run-3', userMemberOfAId, tenantBId, tenantAId),
        async () => 'never',
      ),
    ).rejects.toBeInstanceOf(TenantBindingError);
  });

  it('binding result is cached — revoking the membership does not take effect until TTL expires', async () => {
    // First call — populates cache as valid.
    const principal = userPrincipal(userMemberOfAId, tenantAId);
    await withTenantContext(principal, async () => 'ok');

    // Revoke the membership out-of-band.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_admin');
      await client.query(
        `DELETE FROM oweibo.tenant_memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        [userMemberOfAId, tenantAId],
      );
      await client.query('COMMIT');
    } finally { client.release(); }

    try {
      // Cache is still warm — the call should succeed even though DB no longer has the row.
      const cached = await withTenantContext(principal, async () => 'ok');
      expect(cached).toBe('ok');

      // After clearing the cache, the call must fail.
      _clearTenantBindingCache();
      await expect(
        withTenantContext(principal, async () => 'never'),
      ).rejects.toBeInstanceOf(TenantBindingError);
    } finally {
      // Restore the membership for downstream tests / cleanup
      const restore = await pool.connect();
      try {
        await restore.query('BEGIN');
        await restore.query('SET LOCAL ROLE platform_admin');
        await restore.query(
          `INSERT INTO oweibo.tenant_memberships (user_id, tenant_id, roles)
           VALUES ($1::uuid, $2::uuid, ARRAY['tenant_developer'])
           ON CONFLICT (user_id, tenant_id) DO NOTHING`,
          [userMemberOfAId, tenantAId],
        );
        await restore.query('COMMIT');
      } finally { restore.release(); }
    }
  });
});
