/**
 * S.1: approval-lifecycle-worker entrypoint.
 *
 * Driven by a setInterval tick (default 30s). Production wiring constructs
 * the engine + router from core-engine and passes them in. The runtime
 * mounts this app in the same way as tenant-bootstrap-worker.
 */
import { Pool } from 'pg';
import { ApprovalLifecycleWorker } from './Worker.js';

const TICK_INTERVAL_MS = Number(process.env.APPROVAL_SLA_TICK_MS ?? 30_000);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Wiring of sla service / escalation engine / notification router lives in
  // the runtime package (avoids pulling core-engine into this worker's
  // dependency closure). The runtime is expected to import {Worker} and
  // construct it with injected dependencies.
  console.error('[approval-lifecycle] worker started; wire via runtime import');
  console.error('[approval-lifecycle] standalone start without runtime wiring is a no-op');

  // Keep the process alive for orchestration parity (k8s, pm2, etc.).
  setInterval(() => undefined, TICK_INTERVAL_MS);
  void pool;
  void ApprovalLifecycleWorker;
}

main().catch((err) => {
  console.error('[approval-lifecycle] fatal:', err);
  process.exit(1);
});
