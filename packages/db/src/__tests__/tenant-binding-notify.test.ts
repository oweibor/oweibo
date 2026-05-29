/**
 * NOTIFY-driven tenant-binding cache invalidation.
 *
 * Verifies that migration 20260519_000019's pg_notify triggers + the
 * tenantBindingListener evict cached binding entries within a small
 * timeout after the underlying row changes — collapsing the 60 s TTL
 * window for revocation propagation.
 *
 * Requires: TEST_DATABASE_URL pointing at a Postgres with all migrations
 * applied and oweibo_app credentials.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  withTenantContext,
  TenantBindingError,
  _clearTenantBindingCache,
} from '../withTenantContext.js';
import {
  startTenantBindingInvalidationListener,
  type TenantBindingListener,
} from '../tenantBindingListener.js';
import type { Principal } from '../types.js';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

/** Loop calling `fn` until it throws or timeoutMs elapses. */
async function pollUntilThrows(fn: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
    } catch (err) {
      lastErr = err;
      return lastErr;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

describeOrSkip('NOTIFY-driven tenant-binding invalidation', () => {
  let pool: Pool;
  let listener: TenantBindingListener;
  let tenantId: string;
  let userId: string;
  let keyId: string;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });

    // Seed fixtures as platform_admin.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE platform_admin');
      const t = await c.query<{ id: string }>(
        `INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant notify', $1, '{}') RETURNING id`,
        [`tenant-notify-${suffix}`],
      );
      tenantId = t.rows[0]!.id;
      const u = await c.query<{ id: string }>(
        `INSERT INTO oweibo.users (id, email, status)
         VALUES (gen_random_uuid(), $1, 'active') RETURNING id`,
        [`notify-${suffix}@test.local`],
      );
      userId = u.rows[0]!.id;
      await c.query(
        `INSERT INTO oweibo.tenant_memberships (user_id, tenant_id, roles)
         VALUES ($1::uuid, $2::uuid, ARRAY['tenant_developer'])`,
        [userId, tenantId],
      );
      const k = await c.query<{ id: string }>(
        `INSERT INTO oweibo.api_keys
           (tenant_id, created_by_user_id, name, prefix, hashed_secret, scopes)
         VALUES ($1::uuid, $2::uuid, 'notify', 'oweibo_ak_', 'x', ARRAY['tasks:write'])
         RETURNING id`,
        [tenantId, userId],
      );
      keyId = k.rows[0]!.id;
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }

    // Start the listener and wait for LISTEN to be established before
    // any test fires a mutation. The listener clears the cache on first
    // ready, so we get a clean slate.
    listener = startTenantBindingInvalidationListener(TEST_DB_URL);
    await listener.ready;
  });

  afterAll(async () => {
    await listener.stop();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE platform_admin');
      await c.query(`DELETE FROM oweibo.api_keys WHERE id = $1::uuid`, [keyId]);
      await c.query(`DELETE FROM oweibo.tenant_memberships WHERE user_id = $1::uuid`, [userId]);
      await c.query(`DELETE FROM oweibo.users WHERE id = $1::uuid`, [userId]);
      await c.query(`DELETE FROM oweibo.tenants WHERE id = $1::uuid`, [tenantId]);
      await c.query('COMMIT');
    } catch { await c.query('ROLLBACK'); }
    finally { c.release(); }
    await pool.end();
  });

  it('deleting a membership invalidates the cached entry within 2 s', async () => {
    _clearTenantBindingCache();
    const principal: Principal = {
      sub: userId,
      kind: 'user',
      scopes: ['tasks:read'],
      ctx: { tenantId },
    };

    // Populate cache as valid.
    await withTenantContext(principal, async () => 'ok');

    // Revoke the membership out-of-band.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE platform_admin');
      await c.query(
        `DELETE FROM oweibo.tenant_memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        [userId, tenantId],
      );
      await c.query('COMMIT');
    } finally { c.release(); }

    // Within 2 s, the listener must have evicted the cache so the next
    // withTenantContext call hits the DB, sees no membership, and throws.
    try {
      const err = await pollUntilThrows(
        () => withTenantContext(principal, async () => 'ok'),
        2_000,
      );
      expect(err).toBeInstanceOf(TenantBindingError);
    } finally {
      // Restore for subsequent tests / cleanup.
      const restore = await pool.connect();
      try {
        await restore.query('BEGIN');
        await restore.query('SET LOCAL ROLE platform_admin');
        await restore.query(
          `INSERT INTO oweibo.tenant_memberships (user_id, tenant_id, roles)
           VALUES ($1::uuid, $2::uuid, ARRAY['tenant_developer'])
           ON CONFLICT (user_id, tenant_id) DO NOTHING`,
          [userId, tenantId],
        );
        await restore.query('COMMIT');
      } finally { restore.release(); }
      // Let the restore's own NOTIFY drain so it doesn't bleed into the next test.
      await new Promise(r => setTimeout(r, 100));
    }
  });

  it('revoking an api-key invalidates the cached entry within 2 s', async () => {
    _clearTenantBindingCache();
    const principal: Principal = {
      sub: `apikey:${keyId}`,
      kind: 'api_key',
      scopes: ['tasks:read'],
      ctx: { tenantId },
    };

    await withTenantContext(principal, async () => 'ok');

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE platform_admin');
      await c.query(
        `UPDATE oweibo.api_keys SET revoked_at = NOW() WHERE id = $1::uuid`,
        [keyId],
      );
      await c.query('COMMIT');
    } finally { c.release(); }

    try {
      const err = await pollUntilThrows(
        () => withTenantContext(principal, async () => 'ok'),
        2_000,
      );
      expect(err).toBeInstanceOf(TenantBindingError);
    } finally {
      const restore = await pool.connect();
      try {
        await restore.query('BEGIN');
        await restore.query('SET LOCAL ROLE platform_admin');
        await restore.query(
          `UPDATE oweibo.api_keys SET revoked_at = NULL WHERE id = $1::uuid`,
          [keyId],
        );
        await restore.query('COMMIT');
      } finally { restore.release(); }
      await new Promise(r => setTimeout(r, 100));
    }
  });
});
