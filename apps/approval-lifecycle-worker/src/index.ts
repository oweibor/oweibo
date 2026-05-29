/**
 * F.2.1: approval-lifecycle-worker entry point.
 *
 * Pre-F.2.1 this entrypoint refused to start unless
 * APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK=true was set, because the worker
 * had no way to construct ApprovalSlaService / EscalationEngine /
 * NotificationRouter from inside its own package. F.2.1 adds the
 * @oweibo/core-engine workspace dep and replaces the refuse-to-start with
 * real wiring through wireWorker() (see ./wireWorker.ts for design notes).
 *
 * Env (all optional except DATABASE_URL):
 *   DATABASE_URL                          — Postgres connection string. REQUIRED.
 *   REDIS_URL                             — wires RedisTaskEventBusPublisher.
 *   APPROVAL_SLA_TICK_MS                  — tick interval (default 30 000).
 *   SMTP_CONFIGURED='true'                — enable EmailChannel.
 *   SLACK_CONFIGURED='true'               — enable SlackChannel.
 *   WEBHOOK_CONFIGURED='true'             — enable WebhookChannel.
 *   POST_EXECUTION_VERIFICATION_ENABLED   — enable deferred-verification tick.
 *
 * Backwards-compat:
 *   APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK is honoured if set. With it,
 *   the worker stays idle (k8s readiness probe parity) without doing any
 *   real work. The pre-F.2.1 refuse-to-start behaviour is gone — without
 *   the ack flag and without DATABASE_URL the process exits with an
 *   operator-readable error.
 */
import { wireWorker } from './wireWorker.js';

async function main(): Promise<void> {
  const ack = process.env['APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK'] === 'true';
  if (ack) {
    runIdleStandalone();
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error([
      '[approval-lifecycle] FATAL: DATABASE_URL is required.',
      '',
      '  This worker drives the approval-SLA FSM; without a DB connection',
      '  there is nothing to do. Provide DATABASE_URL or set',
      '  APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK=true for an idle process.',
    ].join('\n'));
    process.exit(2);
  }

  const wired = wireWorker({
    databaseUrl,
    redisUrl: process.env['REDIS_URL'],
  });
  const channelsConfigured = describeChannels();
  console.log(
    `[approval-lifecycle] starting tick loop; channels=${channelsConfigured}; ` +
    `redis=${process.env['REDIS_URL'] ? 'wired' : 'absent'}`,
  );

  const ticker = wired.startTickLoop();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[approval-lifecycle] received ${signal}; shutting down`);
    ticker.stop();
    await wired.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

/**
 * Idle process for orchestrator parity (k8s readinessProbe, pm2 restart
 * loop) when the operator has explicitly acknowledged no-op mode.
 */
function runIdleStandalone(): void {
  console.warn([
    '[approval-lifecycle] APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK=true',
    '  Running as an idle no-op process. Approvals will NOT be escalated',
    '  or expired. Unset the ack flag and supply DATABASE_URL to enable',
    '  real processing.',
  ].join('\n'));
  // Keep the event loop alive without doing work.
  setInterval(() => undefined, 60_000);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT',  () => process.exit(0));
}

function describeChannels(): string {
  const on: string[] = ['in_app'];
  if (process.env['SMTP_CONFIGURED']    === 'true') on.push('email');
  if (process.env['SLACK_CONFIGURED']   === 'true') on.push('slack');
  if (process.env['WEBHOOK_CONFIGURED'] === 'true') on.push('webhook');
  return on.join(',');
}

main().catch((err) => {
  console.error('[approval-lifecycle] fatal:', err);
  process.exit(1);
});
