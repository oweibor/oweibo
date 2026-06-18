#!/usr/bin/env tsx
/**
 * backfill-tenant-bootstrap.ts — one-shot operator script.
 *
 * Iterates oweibo.tenants for every row that has NO matching tenant_bootstrap
 * entry, then inserts one with state='pending' and emits a tenant.created.v1
 * outbox event so the BootstrapWorker picks it up.
 *
 * Use this after T.1 deploys if operators want existing tenants to receive
 * the seed content shipped by later T.2+ phases.
 *
 * Safe to re-run: the WHERE NOT EXISTS guard prevents double-inserts; the
 * outbox idempotency comes from the lifecycle event being a no-op when the
 * tenant_bootstrap row is already in a terminal state.
 *
 * Env:
 *   DATABASE_URL — required
 *   DRY_RUN=true — print counts and exit without writing
 *   TEMPLATE_SLUG=<slug> — defaults to 'default'
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

async function main(): Promise<void> {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL) {
    console.error('[backfill] DATABASE_URL required');
    process.exit(1);
  }
  const dryRun = process.env['DRY_RUN'] === 'true';
  const templateSlug = process.env['TEMPLATE_SLUG'] ?? 'default';

  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
    const candidates = await client.query<{
      id: string;
      slug: string;
      created_by: string | null;
      created_at: Date;
    }>(
      `SELECT t.id, t.slug, t.created_by, t.created_at
         FROM oweibo.tenants t
         LEFT JOIN oweibo.tenant_bootstrap b ON b.tenant_id = t.id
        WHERE b.tenant_id IS NULL
        ORDER BY t.created_at ASC`,
    );
    console.log(`[backfill] ${candidates.rows.length} tenant(s) without tenant_bootstrap`);
    if (dryRun) {
      console.log('[backfill] DRY_RUN — no writes');
      return;
    }
    for (const t of candidates.rows) {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO oweibo.tenant_bootstrap (tenant_id, state, template_slug)
           VALUES ($1::uuid, 'pending', $2)
           ON CONFLICT (tenant_id) DO NOTHING`,
          [t.id, templateSlug],
        );
        const payload = {
          schemaVersion: '1',
          tenantId: t.id,
          slug: t.slug,
          templateSlug,
          createdBy: t.created_by,
          createdAt: t.created_at.toISOString(),
        };
        await client.query(
          `INSERT INTO oweibo.outbox (id, subject, payload)
           VALUES ($1::uuid, 'tenant.created.v1', $2::jsonb)`,
          [randomUUID(), JSON.stringify(payload)],
        );
        await client.query('COMMIT');
        console.log(`[backfill] enqueued ${t.id} (${t.slug})`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.error(`[backfill] failed for ${t.id}`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((err) => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
