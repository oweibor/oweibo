/**
 * T.1: tenant-bootstrap-worker entry point.
 *
 * Subscribes to oweibo.lifecycle.tenant.created.v1 and drives the bootstrap
 * pipeline for each event. On startup, also runs a one-shot reconciliation
 * pass over any tenant_bootstrap rows still in state 'pending' or 'failed'
 * (e.g. if the worker crashed mid-pipeline) so they get re-attempted.
 *
 * Env:
 *   DATABASE_URL — required
 *   REDIS_URL    — defaults to redis://localhost:6379
 *   BOOTSTRAP_RECONCILE_INTERVAL_MS — default 6h, periodic sweep
 */
import { Pool } from 'pg';
import { default as IORedis } from 'ioredis';
import { TENANT_CREATED_V1_SUBJECT, type TenantCreatedV1Payload } from '@oweibo/core-contracts';
import { BootstrapWorker, defaultFeaturesLoader } from './BootstrapWorker.js';

interface LifecycleEnvelope {
  subject: string;
  payload: TenantCreatedV1Payload;
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL) {
    console.error('[tenant-bootstrap-worker] DATABASE_URL required');
    process.exit(1);
  }
  const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const RECONCILE_INTERVAL_MS = parseInt(
    process.env['BOOTSTRAP_RECONCILE_INTERVAL_MS'] ?? `${6 * 60 * 60 * 1000}`,
    10,
  );

  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await sub.connect();

  const worker = new BootstrapWorker(pool, defaultFeaturesLoader);

  const channel = `oweibo.lifecycle.${TENANT_CREATED_V1_SUBJECT}`;
  await sub.subscribe(channel);
  console.log(`[tenant-bootstrap-worker] subscribed to ${channel}`);

  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return;
    void handleMessage(raw, worker);
  });

  // Initial reconcile + periodic sweep.
  void reconcile(pool, worker);
  const timer = setInterval(() => void reconcile(pool, worker), RECONCILE_INTERVAL_MS);
  timer.unref?.();

  const shutdown = async (): Promise<void> => {
    console.log('[tenant-bootstrap-worker] shutting down');
    clearInterval(timer);
    await sub.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

async function handleMessage(raw: string, worker: BootstrapWorker): Promise<void> {
  let envelope: LifecycleEnvelope;
  try {
    envelope = JSON.parse(raw) as LifecycleEnvelope;
  } catch {
    console.warn('[tenant-bootstrap-worker] dropping malformed message');
    return;
  }
  if (envelope.subject !== TENANT_CREATED_V1_SUBJECT) return;
  const tenantId = envelope.payload?.tenantId;
  if (!tenantId) {
    console.warn('[tenant-bootstrap-worker] event missing tenantId');
    return;
  }
  try {
    const result = await worker.handleTenantCreated(tenantId);
    console.log(`[tenant-bootstrap-worker] tenant ${tenantId} → ${result}`);
  } catch (err) {
    console.error('[tenant-bootstrap-worker] handler threw', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function reconcile(pool: Pool, worker: BootstrapWorker): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
    const stuck = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id
         FROM oweibo.tenant_bootstrap
        WHERE state IN ('pending','failed')
        ORDER BY updated_at ASC
        LIMIT 100`,
    );
    if (stuck.rows.length > 0) {
      console.log(`[tenant-bootstrap-worker] reconcile sweep: ${stuck.rows.length} tenant(s)`);
    }
    for (const row of stuck.rows) {
      try {
        await worker.handleTenantCreated(row.tenant_id);
      } catch (err) {
        console.error('[tenant-bootstrap-worker] reconcile threw', {
          tenantId: row.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    client.release();
  }
}

void main().catch((err) => {
  console.error('[tenant-bootstrap-worker] fatal', err);
  process.exit(1);
});
