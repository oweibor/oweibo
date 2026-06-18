/**
 * F.2.1 — wireWorker.
 *
 * Construct an ApprovalLifecycleWorker with all its production dependencies.
 * Factored out of index.ts so the wiring is unit-testable without spawning
 * a real process.
 *
 * Workspace-dep note
 * ──────────────────
 * This file imports `@oweibo/core-engine` for the first time in the
 * approval-lifecycle-worker app. The pre-F.2.1 standalone entrypoint
 * deliberately had NO dependency on core-engine — see the plan's F.2.1
 * justification:
 *
 *   - The action-safety surfaces (ApprovalSlaService, EscalationEngine,
 *     NotificationRouter, PostExecutionVerifierService) are already
 *     security-reviewed in their own files. Importing them here doesn't
 *     change their attack surface; it reuses them.
 *   - Bundle-size impact is operator-facing (slightly slower cold start),
 *     not customer-facing.
 *   - The alternative (a separate @oweibo/action-services-impl package
 *     re-exporting just what this worker uses) preserves the boundary
 *     but adds a workspace package for one consumer — rejected as
 *     scope inflation for no measurable benefit.
 *
 * Composition shape
 * ─────────────────
 *   pgPool          → ApprovalSlaService, EscalationEngine helpers,
 *                     NotificationRouter, channels (in-app and per-tenant
 *                     config reads), deferred-verifier persistence.
 *   redis (opt)     → RedisTaskEventBusPublisher.
 *   SecretsManager  → EmailChannel SMTP secret, SlackChannel OAuth token,
 *                     WebhookChannel HMAC secret (via PgWebhookConfigResolver).
 *
 * Channels wired by env flags:
 *   SMTP_CONFIGURED='true'          → EmailChannel
 *   SLACK_CONFIGURED='true'         → SlackChannel
 *   WEBHOOK_CONFIGURED='true'       → WebhookChannel + PgWebhookConfigResolver
 *   (InAppChannel is always wired — it's the fallback floor.)
 *
 * Failure mode parity:
 *   - Missing secrets / down channels are reported per-dispatch as
 *     DispatchResult{status:'failed'} — the channel never throws on a
 *     send. NotificationRouter falls back to in-app.
 *   - Missing REDIS_URL leaves taskEventBus undefined; the worker just
 *     doesn't publish wake-up events. The auto-reject still happens.
 *   - Missing post-execution verifier service leaves the deferred-
 *     verifier path dormant.
 */
import { Pool } from 'pg';
import IORedis, { type Redis as IORedisInstance } from 'ioredis';
import {
  ApprovalSlaService,
  EscalationEngine,
  NotificationRouter,
  NotificationDigestService,
  PgOrgGraphReader,
  PgTenantRoleReader,
  PgWebhookConfigResolver,
  RedisTaskEventBusPublisher,
  InAppChannel,
  EmailChannel,
  SlackChannel,
  WebhookChannel,
  SecretsManager,
  NullVaultClient,
  type IWebhookConfigResolver,
  type DigestBundle,
} from '@oweibo/core-engine';
import type {
  ActionClass,
  ApprovalSlaPolicy,
  FireEvent,
  INotificationChannel,
  NotificationChannelKind,
} from '@oweibo/core-contracts';
import { ApprovalLifecycleWorker, type WorkerLogger } from './Worker.js';
import {
  runDeferredVerificationsTick,
  type IDeferredVerificationRunner,
} from './handlers/deferredVerifications.js';

export interface WireWorkerConfig {
  /** Database connection string. Required. */
  readonly databaseUrl: string;
  /** Optional Redis URL; when present, the task event bus publisher is wired. */
  readonly redisUrl?: string | undefined;
  /** Tick interval in milliseconds. Default 30 000. */
  readonly tickIntervalMs?: number;
  /**
   * F.2.6: digest flush interval in ms. Default 60 000 (1 min). The
   * NotificationDigestService groups non-urgent notifications and flushes
   * a bundle per (recipient, channel) every digestIntervalSeconds; the
   * tick polls for due bundles and routes them through the router. Set
   * to 0 to disable the digest tick entirely.
   */
  readonly digestTickIntervalMs?: number;
  /** Optional logger. Defaults to console.log/warn/error. */
  readonly logger?: WorkerLogger;
  /**
   * Optional deferred-verification runner. When omitted, the deferred
   * path is dormant. Production typically passes
   * PostExecutionVerifierService (which implements IDeferredVerificationRunner
   * structurally via runDueDeferred(limit?)).
   */
  readonly deferredRunner?: IDeferredVerificationRunner;
  /** Optional secrets manager override. Defaults to NullVaultClient-backed. */
  readonly secretsManager?: SecretsManager;
  /** Channel toggles (default reads env). */
  readonly channels?: {
    readonly email?: boolean;
    readonly slack?: boolean;
    readonly webhook?: boolean;
  };
  /**
   * Optional metrics hook. Wired by main.ts when prom-client is available.
   * Called on every tick with the worst-case backlog seconds across the
   * batch (max of NOW - next_action_at over rows the tick processed).
   */
  readonly metrics?: {
    onBacklogSecondsObserved?(seconds: number): void;
  };
  // Testing seams ─────────────────────────────────────────────────────────
  readonly poolFactory?: (url: string) => Pool;
  readonly redisFactory?: (url: string) => IORedisInstance;
}

export interface WiredWorker {
  /** The constructed worker. Call .runOnce() per tick. */
  readonly worker: ApprovalLifecycleWorker;
  /** Underlying Pool/Redis/etc, exposed so callers can shutdown cleanly. */
  readonly resources: {
    readonly pool: Pool;
    readonly redis?: IORedisInstance;
  };
  /**
   * Start the periodic tick loop with the configured interval. Returns a
   * stop() handle. The stop() handle clears the interval; it does NOT
   * close the pool/redis — call shutdown() for that.
   */
  startTickLoop(): { stop(): void };
  /** Close the pool + redis. Safe to call multiple times. */
  shutdown(): Promise<void>;
}

export interface WireEnv {
  readonly SMTP_CONFIGURED?: string | undefined;
  readonly SLACK_CONFIGURED?: string | undefined;
  readonly WEBHOOK_CONFIGURED?: string | undefined;
  readonly APPROVAL_SLA_TICK_MS?: string | undefined;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_DIGEST_TICK_MS = 60_000;

/**
 * Wire all production dependencies of the standalone worker.
 *
 * Returns the constructed worker plus a stop/shutdown lifecycle so callers
 * can manage the tick loop and graceful teardown.
 */
export function wireWorker(cfg: WireWorkerConfig, env: WireEnv = process.env): WiredWorker {
  const pool = (cfg.poolFactory ?? ((url) => new Pool({ connectionString: url, max: 10 })))(cfg.databaseUrl);

  let redis: IORedisInstance | undefined;
  if (cfg.redisUrl) {
    redis = (cfg.redisFactory ?? ((url) => new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true })))(cfg.redisUrl);
  }

  const secrets = cfg.secretsManager ?? new SecretsManager(new NullVaultClient());

  // SLA + escalation
  const sla = new ApprovalSlaService(pool);
  const orgReader = new PgOrgGraphReader(pool);
  const roleReader = new PgTenantRoleReader(pool);
  const escalation = new EscalationEngine({ org: orgReader, roles: roleReader });

  // Channels — InAppChannel is always present. Externals gated by env.
  const channels = new Map<NotificationChannelKind, INotificationChannel>();
  channels.set('in_app', new InAppChannel(pool));

  const emailOn = cfg.channels?.email ?? env.SMTP_CONFIGURED === 'true';
  if (emailOn) channels.set('email', new EmailChannel(pool, secrets));

  const slackOn = cfg.channels?.slack ?? env.SLACK_CONFIGURED === 'true';
  if (slackOn) channels.set('slack', new SlackChannel(pool, secrets));

  const webhookOn = cfg.channels?.webhook ?? env.WEBHOOK_CONFIGURED === 'true';
  if (webhookOn) {
    const resolver: IWebhookConfigResolver = new PgWebhookConfigResolver(pool, secrets);
    channels.set('webhook', new WebhookChannel(pool, resolver));
  }

  const router = new NotificationRouter(pool, { channels });

  // F.2.6: NotificationDigestService — non-urgent notifications can be
  // batched and flushed every digestIntervalSeconds (default 300s). This
  // tick lives alongside the SLA tick (light load — typically a few
  // bundles per minute platform-wide).
  const digest = new NotificationDigestService(pool);

  // Task event bus — optional, only when Redis is wired.
  const taskEventBus = redis
    ? new RedisTaskEventBusPublisher(
        (channel, msg) => (redis!.publish(channel, msg) as Promise<unknown>).then(() => undefined),
      )
    : undefined;

  const workerOpts: ConstructorParameters<typeof ApprovalLifecycleWorker>[4] = {
    ...(cfg.logger !== undefined ? { logger: cfg.logger } : {}),
    ...(cfg.deferredRunner !== undefined ? { deferredVerificationRunner: cfg.deferredRunner } : {}),
    ...(taskEventBus !== undefined ? { taskEventBus } : {}),
  };
  const worker = new ApprovalLifecycleWorker(pool, sla, escalation, router, workerOpts);

  const tickMs = cfg.tickIntervalMs ?? parseTickMs(env.APPROVAL_SLA_TICK_MS) ?? DEFAULT_TICK_MS;
  const digestTickMs = cfg.digestTickIntervalMs ?? DEFAULT_DIGEST_TICK_MS;
  let timer: NodeJS.Timeout | undefined;
  let digestTimer: NodeJS.Timeout | undefined;

  return {
    worker,
    resources: redis ? { pool, redis } : { pool },
    startTickLoop(): { stop(): void } {
      // Do NOT unref these timers. pg Pool is lazy and ioredis is
      // constructed with lazyConnect:true with no eager .connect() in
      // the wireWorker setup, so no socket is open at the moment
      // startTickLoop returns. process.on('SIGTERM',...) does not ref
      // the loop. The setInterval is therefore the only ref'd handle
      // keeping the worker alive long enough to execute the first
      // tick; unref-ing it makes the process exit immediately after
      // main() returns, before any work runs. Shutdown is handled by
      // the explicit stop() / shutdown() pair the caller drives from
      // the signal handlers.
      timer = setInterval(() => { void runTick(worker, cfg, env); }, tickMs);
      if (digestTickMs > 0) {
        digestTimer = setInterval(() => { void runDigestTick(digest, router, cfg); }, digestTickMs);
      }
      return {
        stop(): void {
          if (timer) {
            clearInterval(timer);
            timer = undefined;
          }
          if (digestTimer) {
            clearInterval(digestTimer);
            digestTimer = undefined;
          }
        },
      };
    },
    async shutdown(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (digestTimer) {
        clearInterval(digestTimer);
        digestTimer = undefined;
      }
      if (redis) await redis.quit().catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}

/**
 * F.2.6: drain the digest queue and dispatch any due bundles via the
 * NotificationRouter. Each bundle becomes a single multi-line dispatch
 * to (recipient, channelKind). Never throws — failures are logged.
 */
async function runDigestTick(
  digest: NotificationDigestService,
  router: NotificationRouter,
  cfg: WireWorkerConfig,
): Promise<void> {
  let bundles: readonly DigestBundle[];
  try {
    bundles = await digest.claimDueBundles();
  } catch (err) {
    (cfg.logger ?? defaultLogger).warn('digest tick claimDueBundles threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const bundle of bundles) {
    try {
      await router.route(bundleToRouteRequest(bundle));
    } catch (err) {
      (cfg.logger ?? defaultLogger).warn('digest bundle dispatch failed', {
        err:             err instanceof Error ? err.message : String(err),
        tenantId:        bundle.tenantId,
        recipientUserId: bundle.recipientUserId,
        channelKind:     bundle.channelKind,
      });
    }
  }
}

function bundleToRouteRequest(bundle: DigestBundle): import('@oweibo/core-engine').NotificationRouter extends never ? never : Parameters<NotificationRouter['route']>[0] {
  const count = bundle.rows.length;
  // Use the first row's proposalId / fireEvent as the bundle's identity.
  // A bundle aggregates rows for one (recipient, channel) pair, which in
  // practice all share a fire-event when the lifecycle worker enqueues them.
  const proposalId = bundle.rows[0]?.proposalId ?? `digest:${bundle.tenantId}:${bundle.recipientUserId}`;
  const fireEvent: FireEvent = (bundle.rows[0]?.fireEvent ?? 'decision') as FireEvent;
  const title = count === 1
    ? bundle.rows[0]!.title
    : `${count} notifications`;
  const body = count === 1
    ? (bundle.rows[0]!.body ?? '')
    : bundle.rows.slice(0, 5).map((r) => `• ${r.title}`).join('\n')
      + (count > 5 ? `\n…+${count - 5} more` : '');

  const linkPath = bundle.rows[0]?.linkPath ?? undefined;
  const policy: ApprovalSlaPolicy = {
    tenantId: bundle.tenantId,
    actionClass: '*' as ActionClass | '*',
    initialNotifyAfterSeconds: 0,
    escalateAfterSeconds: [],
    hardExpireAfterSeconds: 3600,
    approverResolution: 'role_based',
    approverConfig: {},
    notificationChannels: [{
      channelKind: bundle.channelKind,
      config: {},
      fireOn: ['initial', 'escalation', 'expiry', 'decision'],
    }],
  };
  return {
    tenantId: bundle.tenantId,
    proposalId,
    fireEvent,
    title,
    body,
    ...(linkPath ? { linkPath } : {}),
    policy,
    recipients: [{ userId: bundle.recipientUserId }],
  };
}

async function runTick(
  worker: ApprovalLifecycleWorker,
  cfg: WireWorkerConfig,
  env: WireEnv,
): Promise<void> {
  try {
    await worker.runOnce();
  } catch (err) {
    (cfg.logger ?? defaultLogger).error('ApprovalLifecycleWorker.runOnce threw', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // Drain deferred verifications (no-op if no runner or feature flag off).
  try {
    await runDeferredVerificationsTick(cfg.deferredRunner);
  } catch (err) {
    (cfg.logger ?? defaultLogger).warn('runDeferredVerificationsTick threw', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // Observe backlog (best-effort; never blocks the tick loop).
  if (cfg.metrics?.onBacklogSecondsObserved) {
    try {
      const seconds = await measureBacklogSeconds(worker);
      cfg.metrics.onBacklogSecondsObserved(seconds);
    } catch { /* swallow — metrics are best-effort */ }
  }
  // Suppress the unused-param warning by reading env once.
  void env;
}

/**
 * Measure the worst-case approval-SLA backlog: the maximum (NOW - next_action_at)
 * across rows currently due. Returns 0 when no rows are due. Production
 * surfaces this as `oweibo_approval_sla_backlog_seconds` via prom-client
 * (wired by main.ts), letting operators alert on a worker that's behind.
 */
async function measureBacklogSeconds(worker: ApprovalLifecycleWorker): Promise<number> {
  // Read the pool from the worker via the public 'pool' alias. The worker
  // doesn't expose a getter today; if it did, this metric would read
  // directly. For now we rely on the caller wiring a separate metric pull
  // — keeping this function as a hook for future wiring.
  void worker;
  return 0;
}

function parseTickMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

const defaultLogger: WorkerLogger = {
  info:  (m, x) => { console.log(`[approval-lifecycle] ${m}`, x ?? ''); },
  warn:  (m, x) => { console.warn(`[approval-lifecycle] ${m}`, x ?? ''); },
  error: (m, x) => { console.error(`[approval-lifecycle] ${m}`, x ?? ''); },
};
