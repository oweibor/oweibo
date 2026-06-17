/**
 * T.1 + F.6: tenant-bootstrap-worker entry point.
 *
 * Consumes oweibo.lifecycle.tenant.created.v1 events and drives the
 * bootstrap pipeline for each. Default transport is Redis pub/sub
 * (legacy). When OUTBOX_STREAMS_ENABLED=true, switches to Redis Streams
 * XREADGROUP via OutboxStreamConsumer with PG-backed dedup (F.6 deploy 2+).
 *
 * On startup, also runs a one-shot reconciliation pass over any
 * tenant_bootstrap rows still in state 'pending' or 'failed' so they
 * get re-attempted after a worker crash.
 *
 * Env:
 *   DATABASE_URL — required
 *   REDIS_URL    — defaults to redis://localhost:6379
 *   BOOTSTRAP_RECONCILE_INTERVAL_MS — default 6h, periodic sweep
 *   OUTBOX_STREAMS_ENABLED — when true, use XREADGROUP; defaults to false (legacy SUBSCRIBE)
 */
import * as os from 'node:os';
import { Pool } from 'pg';
import { default as IORedis } from 'ioredis';
import { TENANT_CREATED_V1_SUBJECT, type TenantCreatedV1Payload } from '@oweibo/core-contracts';
import {
  OutboxStreamConsumer,
  PgProcessedOutboxDedupStore,
  withTenantScope,
  type IRedisStreamClient,
} from '@oweibo/core-engine';
import { BootstrapWorker, defaultFeaturesLoader } from './BootstrapWorker.js';
import { buildBootstrapPipeline } from './wiring.js';

const CONSUMER_GROUP = 'bootstrap-workers';

interface LifecycleEnvelope {
  subject: string;
  payload: TenantCreatedV1Payload;
}

async function main(): Promise<void> {
  // F.7.1: bootstrap OpenTelemetry before any other module work.
  if (process.env['OWEIBO_TRACING_ENABLED'] === 'true') {
    const { initOtel } = await import('@oweibo/observability');
    initOtel(process.env['OTEL_SERVICE_NAME'] ?? 'tenant-bootstrap-worker');
    console.log('[tenant-bootstrap-worker] OpenTelemetry SDK initialised');
  }

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

  // Pool size 10 covers: the live-event pipeline (one tx per step) +
  // the concurrent reconcile sweep (up to 100 tenants iterated, each
  // running a small handful of nested transactions). 3 was a frequent
  // bottleneck under bursty tenant creation.
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  await sub.connect();

  // F.5: construct the wired pipeline from env-resolved infra. Steps
  // whose infra isn't available stay unwired -- validatePipeline reports
  // them and BOOTSTRAP_ALLOW_UNWIRED_STEPS gates start.
  const { pipeline, notes } = await buildBootstrapPipeline({ pool, redis: sub });
  for (const note of notes) console.log(`[tenant-bootstrap-worker] wiring: ${note}`);
  const worker = new BootstrapWorker(pool, defaultFeaturesLoader, { pipeline });

  // Audit-fix: the default STEP_PIPELINE instantiates each step without
  // its writer/seeder/cloner adapters. In production this silently
  // marks every tenant 'ready' with zero content installed. Refuse to
  // start unless either (a) every step is wired (the operator passed a
  // custom pipeline via the runtime wiring layer), or (b) the operator
  // explicitly acknowledges the no-op mode via env override.
  const report = worker.validatePipeline();
  if (report.unwired.length > 0) {
    const allowUnwired = process.env['BOOTSTRAP_ALLOW_UNWIRED_STEPS'] === 'true';
    const lines = [
      '[tenant-bootstrap-worker] pipeline validation: unwired adapters detected',
      `  wired:   [${report.wired.join(', ')}]`,
      `  unwired: [${report.unwired.join(', ')}]`,
      '  Steps without adapters silently return "skipped" — tenants will be',
      '  marked READY with no seeded content. Wire adapters via the runtime',
      '  composition layer (custom BootstrapWorker pipeline) before starting',
      '  this worker in a real environment.',
    ];
    if (!allowUnwired) {
      lines.push(
        '  Refusing to start. Set BOOTSTRAP_ALLOW_UNWIRED_STEPS=true to override',
        '  (acknowledging that this worker will not seed any tenant content).',
      );
      console.error(lines.join('\n'));
      await sub.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
      process.exit(2);
    }
    console.warn(lines.join('\n'));
    console.warn('[tenant-bootstrap-worker] BOOTSTRAP_ALLOW_UNWIRED_STEPS=true; proceeding in no-op mode.');
  } else {
    console.log(`[tenant-bootstrap-worker] all ${report.wired.length} pipeline step(s) wired.`);
  }

  const channel = `oweibo.lifecycle.${TENANT_CREATED_V1_SUBJECT}`;
  // F.6 review fix: parse the streams env var STRICTLY -- only literal
  // 'true' or 'false' (or unset) is accepted. Without this, a typo
  // ('tru', 'TRUE', '1', 'yes') silently fell through to the `else`
  // branch and de-subscribed the worker -- events fired on pub/sub
  // had no consumer and the worker only recovered them via the 6h
  // reconcile sweep.
  const streamsEnabled = parseStrictBoolEnv('OUTBOX_STREAMS_ENABLED');
  let streamConsumer: OutboxStreamConsumer | null = null;
  let streamClient: IORedis | null = null;
  const dedupStore = new PgProcessedOutboxDedupStore(pool);

  if (streamsEnabled === true) {
    // F.6 deploy 2+: consume via XREADGROUP with PG-backed dedup.
    // Separate ioredis instance so the SUBSCRIBE/XREADGROUP modes don't
    // share connection state.
    streamClient = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    await streamClient.connect();
    streamConsumer = new OutboxStreamConsumer(
      streamClient as unknown as IRedisStreamClient,
      {
        streamKey:    channel,
        consumerGroup: CONSUMER_GROUP,
        consumerName: `${os.hostname()}-${process.pid}`,
        dedupStore,
      },
      async ({ payload }) => handleMessage(payload, worker),
    );
    await streamConsumer.ensureGroup();
    streamConsumer.start();
    console.log(`[tenant-bootstrap-worker] F.6 stream consumer ACTIVE on ${channel} group=${CONSUMER_GROUP}`);
  } else {
    // Legacy pub/sub (F.6 deploy 0 / 1).
    await sub.subscribe(channel);
    console.log(`[tenant-bootstrap-worker] legacy SUBSCRIBE ACTIVE on ${channel}`);
    sub.on('message', (ch: string, raw: string) => {
      if (ch !== channel) return;
      void handleMessage(raw, worker);
    });
  }

  // Initial reconcile + periodic sweep.
  void reconcile(pool, worker);
  const timer = setInterval(() => void reconcile(pool, worker), RECONCILE_INTERVAL_MS);
  timer.unref?.();

  const shutdown = async (): Promise<void> => {
    console.log('[tenant-bootstrap-worker] shutting down');
    clearInterval(timer);
    streamConsumer?.stop();
    await streamClient?.quit().catch(() => undefined);
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
  // F.5 audit fix: previously this loop did `SET LOCAL ROLE platform_admin`
  // on a raw connection (no BEGIN), so the SET LOCAL was discarded by
  // Postgres semantics and the SELECT ran under RLS as oweibo_app with
  // no app.tenant_id set -> zero rows -> the periodic recovery sweep
  // never observed a stuck tenant. withTenantScope(pool, null, …)
  // opens a transaction and sets the role for the SELECT; downstream
  // handleTenantCreated still manages its own per-tenant scope.
  const stuck = await withTenantScope(pool, null, async (client) =>
    client.query<{ tenant_id: string }>(
      `SELECT tenant_id
         FROM oweibo.tenant_bootstrap
        WHERE state IN ('pending','failed')
        ORDER BY updated_at ASC
        LIMIT 100`,
    ),
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
}

/**
 * Strict boolean env-var parser: accepts ONLY undefined, 'true', or
 * 'false' (case-sensitive). Anything else exits the process with a
 * clear error before the worker can silently de-subscribe / mis-route.
 *
 * The original `process.env['OUTBOX_STREAMS_ENABLED'] === 'true'`
 * pattern silently treated any typo as `false`, which de-subscribed
 * the worker from pub/sub without warning -- a class of operability
 * bug F.7 review explicitly called out.
 */
export function parseStrictBoolEnv(name: string): boolean {
  const v = process.env[name];
  if (v === undefined || v === 'false') return false;
  if (v === 'true') return true;
  console.error(
    `[tenant-bootstrap-worker] ${name} must be exactly 'true', 'false', or unset. ` +
    `Got ${JSON.stringify(v)}. Refusing to start.`,
  );
  process.exit(2);
}

void main().catch((err) => {
  console.error('[tenant-bootstrap-worker] fatal', err);
  process.exit(1);
});
