/**
 * S.5.b: deferred-verification handler hosted by the ApprovalLifecycleWorker.
 *
 * The worker calls runDeferredVerificationsTick() once per tick AFTER its
 * approval-SLA loop. Implementation is intentionally narrow — it simply
 * delegates to the engine-side PostExecutionVerifierService.runDueDeferred()
 * which owns claim/run/record/retry semantics. The worker just supplies
 * the polling cadence and the cross-tenant database scope.
 *
 * The handler is decoupled from PostExecutionVerifierService at the type
 * level so the worker app never imports core-engine directly (preserves
 * the worker's lightweight dependency surface).
 */

export interface IDeferredVerificationRunner {
  /**
   * Runs one batch (up to `limit` rows). Returns the number of rows
   * processed (regardless of per-row outcome). Must be tenant-scope-safe;
   * the engine implementation manages app.tenant_id internally.
   */
  runDueDeferred(limit?: number): Promise<number>;
}

export interface DeferredVerificationTickOptions {
  /** Per-tick batch size; default 100. */
  batchSize?: number;
  /** When false, the tick is a no-op. Default reads env flag. */
  isEnabled?: () => boolean;
  log?: (msg: string, ctx?: unknown) => void;
}

export async function runDeferredVerificationsTick(
  runner: IDeferredVerificationRunner | undefined,
  opts: DeferredVerificationTickOptions = {},
): Promise<{ processed: number; skipped: 'disabled' | 'no_runner' | null }> {
  const enabled = opts.isEnabled ?? defaultEnabled;
  if (!enabled()) return { processed: 0, skipped: 'disabled' };
  if (!runner) return { processed: 0, skipped: 'no_runner' };
  const batchSize = opts.batchSize ?? 100;
  try {
    const processed = await runner.runDueDeferred(batchSize);
    if (processed > 0) (opts.log ?? defaultLog)(`deferred verifier processed ${processed} row(s)`);
    return { processed, skipped: null };
  } catch (err) {
    (opts.log ?? defaultLog)(`deferred verifier tick error`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return { processed: 0, skipped: null };
  }
}

function defaultEnabled(): boolean {
  return process.env.POST_EXECUTION_VERIFICATION_ENABLED === 'true';
}

function defaultLog(msg: string, ctx?: unknown): void {
  console.log(`[approval-lifecycle:deferred-verify] ${msg}`, ctx ?? '');
}
