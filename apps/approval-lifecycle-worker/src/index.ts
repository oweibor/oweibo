/**
 * S.1: approval-lifecycle-worker entrypoint.
 *
 * Architecture: this worker process intentionally has NO dependency on
 * @oweibo/core-engine — it consumes the SLA service, escalation engine,
 * and notification router via the three contract-only interfaces on
 * ApprovalLifecycleWorker's constructor. A production runtime imports
 * { ApprovalLifecycleWorker } from this package, constructs concrete
 * implementations of those interfaces from core-engine, and drives the
 * tick.
 *
 * **This standalone entrypoint does NOT wire the services**, so running
 * `node dist/index.js` without runtime composition would silently
 * accomplish nothing — every approval would sit forever.
 *
 * Audit-fix: refuse to start in standalone mode unless the operator
 * explicitly acknowledges the no-op via env override. This makes the
 * unwired state loud instead of silent and prevents an accidental
 * "deployed but inert" production state.
 */
import { Pool } from 'pg';
import { ApprovalLifecycleWorker } from './Worker.js';

const TICK_INTERVAL_MS = Number(process.env.APPROVAL_SLA_TICK_MS ?? 30_000);

async function main(): Promise<void> {
  const acknowledged = process.env['APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK'] === 'true';

  if (!acknowledged) {
    console.error([
      '[approval-lifecycle] FATAL: standalone entrypoint cannot wire services.',
      '',
      '  This worker requires concrete implementations of:',
      '    - IApprovalSlaService (ApprovalSlaService from @oweibo/core-engine)',
      '    - IEscalationEngine    (EscalationEngine from @oweibo/core-engine)',
      '    - INotificationRouter  (NotificationRouter from @oweibo/core-engine)',
      '',
      '  Without them, every require_approval proposal sits in `pending`',
      '  forever — never notified, never escalated, never auto-expired.',
      '',
      '  Production deployments MUST run this worker via a runtime layer',
      '  that imports { ApprovalLifecycleWorker } from this package and',
      '  injects the dependencies (see Worker.test.ts for the wiring shape).',
      '',
      '  To explicitly start the no-op standalone process (e.g. so a k8s',
      '  deployment slot doesn\'t crash-loop while you finish wiring it up),',
      '  set APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK=true.',
    ].join('\n'));
    process.exit(2);
  }

  // Acknowledged no-op mode — sit idle, keep the process alive for
  // orchestration parity (k8s readinessProbe, pm2 restart loop, etc.).
  // The pool + Worker references are kept so static analysis still
  // counts this as a "real" entrypoint and the import graph stays sound.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.warn('[approval-lifecycle] APPROVAL_LIFECYCLE_STANDALONE_NOOP_ACK=true; running as no-op.');
  console.warn('[approval-lifecycle] Approvals will NOT be escalated or expired by this process.');
  setInterval(() => undefined, TICK_INTERVAL_MS);
  const shutdown = async (): Promise<void> => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  void ApprovalLifecycleWorker;
}

main().catch((err) => {
  console.error('[approval-lifecycle] fatal:', err);
  process.exit(1);
});
