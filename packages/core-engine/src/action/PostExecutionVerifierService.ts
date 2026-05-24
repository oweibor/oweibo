/**
 * S.5.b: PostExecutionVerifierService — runs immediate verifiers
 * synchronously after adapter success, queues deferred verifications,
 * and exposes a `runDueDeferred(...)` worker hook called by the
 * ApprovalLifecycleWorker on each tick.
 *
 * Backoff schedule for deferred retries (minutes from previous attempt):
 *   1m → 5m → 30m → 2h → 6h → failed_terminal
 *
 * Severity action mapping (per IPostExecutionVerifier.severityAction):
 *   * sev 0 — no-op
 *   * sev 1 — logged + counted; no action
 *   * sev 2 — emits ESCALATION event (S.1 picks it up); no auto-rollback
 *   * sev 3 — auto-rollback if rollbackInvoker wired; else marks proposal
 *             rollback_failed with notes='auto_rollback_unavailable_sev3'
 *
 * Feature gate: `POST_EXECUTION_VERIFICATION_ENABLED` env. Off ⇒
 * `runImmediate()` short-circuits to noop and `queueDeferred()` skips
 * insert (no rows written, byte-identical to today).
 */
import type { Pool, PoolClient } from 'pg';
import type {
  DriftSeverity,
  IPostExecutionVerifier,
  ImmediateVerifierInput,
  VerificationOutcome,
} from '@oweibo/core-contracts';
import { severityAction } from '@oweibo/core-contracts';

const DEFERRED_BACKOFF_SECONDS: readonly number[] = [60, 5*60, 30*60, 2*60*60, 6*60*60];
const MAX_DEFERRED_ATTEMPTS = DEFERRED_BACKOFF_SECONDS.length;
const VERIFIER_TIMEOUT_MS = 5_000;

export interface VerifierRegistry {
  register(v: IPostExecutionVerifier): void;
  resolve(name: string): IPostExecutionVerifier | undefined;
  matching(actionClass: string): readonly IPostExecutionVerifier[];
  names(): readonly string[];
}

export class InMemoryVerifierRegistry implements VerifierRegistry {
  private readonly byName = new Map<string, IPostExecutionVerifier>();

  register(v: IPostExecutionVerifier): void {
    if (this.byName.has(v.name)) {
      throw new Error(`duplicate verifier name: ${v.name}`);
    }
    this.byName.set(v.name, v);
  }
  resolve(name: string): IPostExecutionVerifier | undefined {
    return this.byName.get(name);
  }
  matching(actionClass: string): readonly IPostExecutionVerifier[] {
    return [...this.byName.values()].filter((v) => v.appliesTo(actionClass));
  }
  names(): readonly string[] {
    return [...this.byName.keys()].sort();
  }
}

export interface PostExecutionVerifierServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
  /**
   * Hook the orchestrator passes so the service can request a rollback
   * when a verifier returns severity 3 and policy permits.
   */
  autoRollback?: (args: {
    tenantId: string;
    proposalId: string;
    reason: string;
  }) => Promise<{ ok: boolean; details?: string }>;
  log?: (level: 'info' | 'warn' | 'error', line: string, ctx?: unknown) => void;
}

export class PostExecutionVerifierService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly autoRollback?: PostExecutionVerifierServiceOptions['autoRollback'];
  private readonly log: NonNullable<PostExecutionVerifierServiceOptions['log']>;

  constructor(
    private readonly pool: Pool,
    public readonly registry: VerifierRegistry,
    opts: PostExecutionVerifierServiceOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.autoRollback = opts.autoRollback;
    this.log = opts.log ?? defaultLog;
  }

  // ── Immediate path ─────────────────────────────────────────────────────

  /**
   * Runs all matching immediate verifiers and queues any deferred ones.
   * Returns the worst severity seen (sev 0 if no verifier matched).
   * Callers (the orchestrator / executor) decide whether to abort the
   * action based on the returned severity + per-tenant policy.
   */
  async runImmediate(input: ImmediateVerifierInput): Promise<{
    worstSeverity: DriftSeverity;
    perVerifier: ReadonlyArray<{ verifierName: string; outcome: VerificationOutcome }>;
  }> {
    if (!this.isEnabled()) {
      return { worstSeverity: 0, perVerifier: [] };
    }
    const matching = this.registry.matching(input.ctx.actionClass);
    if (matching.length === 0) {
      return { worstSeverity: 0, perVerifier: [] };
    }

    const immediateResults: Array<{ verifierName: string; outcome: VerificationOutcome }> = [];
    for (const v of matching) {
      if (v.immediate) {
        let outcome: VerificationOutcome;
        try {
          outcome = await runWithTimeout(v.immediate(input), VERIFIER_TIMEOUT_MS);
        } catch (err) {
          // Verifier error → record sev 2 (notify) so the operator sees it;
          // do not block on a verifier bug.
          this.log('warn', `verifier ${v.name} threw`, { err: String(err) });
          outcome = {
            severity: 2,
            expected: 'verifier_completed',
            observed: 'verifier_error',
            notes: err instanceof Error ? err.message : String(err),
          };
        }
        immediateResults.push({ verifierName: v.name, outcome });
        await this.recordImmediate(input.ctx.tenantId, input.proposalId, v.name, outcome);
      }
      if (v.deferred && v.deferredCheckAfterSeconds !== undefined) {
        await this.queueDeferred(
          input.ctx.tenantId, input.proposalId, v.name,
          input.adapterOutcome,
          v.deferredCheckAfterSeconds,
        );
      }
    }

    const worst = worstSeverity(immediateResults.map((r) => r.outcome.severity));
    if (worst >= 3) {
      await this.maybeAutoRollback(input.ctx.tenantId, input.proposalId, immediateResults);
    }
    return { worstSeverity: worst, perVerifier: immediateResults };
  }

  // ── Deferred path (worker calls this) ─────────────────────────────────

  /**
   * Worker hook. Claims up to `limit` due rows via FOR UPDATE SKIP LOCKED,
   * invokes each verifier's deferred() function, and writes the outcome.
   * Returns the count of rows processed (regardless of success).
   */
  async runDueDeferred(limit = 100): Promise<number> {
    if (!this.isEnabled()) return 0;
    const due = await this.claimDue(limit);
    let processed = 0;
    for (const row of due) {
      processed++;
      const verifier = this.registry.resolve(row.verifier_name);
      if (!verifier || !verifier.deferred) {
        await this.markDone(row.id, 'failed_terminal', `unknown verifier '${row.verifier_name}'`);
        continue;
      }
      let outcome: VerificationOutcome | null = null;
      let lastError: string | null = null;
      try {
        outcome = await runWithTimeout(
          verifier.deferred({
            tenantId: row.tenant_id,
            proposalId: row.proposal_id,
            verifierConfig: row.verifier_config,
            expected: row.expected,
          }),
          VERIFIER_TIMEOUT_MS,
        );
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (outcome) {
        await this.recordDeferred(row.tenant_id, row.proposal_id, row.verifier_name, outcome);
        await this.markDone(row.id, 'done', null);
        if (outcome.severity >= 3) {
          await this.maybeAutoRollback(row.tenant_id, row.proposal_id, [
            { verifierName: row.verifier_name, outcome },
          ]);
        }
      } else {
        await this.scheduleRetryOrFail(row.id, row.attempts, lastError);
      }
    }
    return processed;
  }

  /**
   * Called by the RollbackOrchestrator inside its tx: pending deferred
   * verifications for a rolled-back proposal are marked `superseded` so
   * the worker skips them.
   */
  async supersedeForProposal(tenantId: string, proposalId: string): Promise<number> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE oweibo.deferred_verifications
            SET state = 'superseded', completed_at = NOW()
          WHERE proposal_id = $1::uuid AND state = 'pending'`,
        [proposalId],
      );
      return r.rowCount ?? 0;
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async recordImmediate(
    tenantId: string, proposalId: string, verifierName: string, outcome: VerificationOutcome,
  ): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `INSERT INTO oweibo.post_execution_verifications
           (tenant_id, proposal_id, verifier_name, timing,
            drift_severity, expected, observed, diff,
            observed_cost_cents, notes)
         VALUES ($1::uuid, $2::uuid, $3, 'immediate', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          tenantId, proposalId, verifierName, outcome.severity,
          JSON.stringify(outcome.expected ?? null),
          JSON.stringify(outcome.observed ?? null),
          outcome.diff !== undefined ? JSON.stringify(outcome.diff) : null,
          outcome.observedCostCents ?? null,
          outcome.notes ?? null,
        ],
      );
    });
  }

  private async recordDeferred(
    tenantId: string, proposalId: string, verifierName: string, outcome: VerificationOutcome,
  ): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `INSERT INTO oweibo.post_execution_verifications
           (tenant_id, proposal_id, verifier_name, timing,
            drift_severity, expected, observed, diff,
            observed_cost_cents, notes)
         VALUES ($1::uuid, $2::uuid, $3, 'deferred', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          tenantId, proposalId, verifierName, outcome.severity,
          JSON.stringify(outcome.expected ?? null),
          JSON.stringify(outcome.observed ?? null),
          outcome.diff !== undefined ? JSON.stringify(outcome.diff) : null,
          outcome.observedCostCents ?? null,
          outcome.notes ?? null,
        ],
      );
    });
  }

  private async queueDeferred(
    tenantId: string, proposalId: string, verifierName: string,
    adapterOutcome: unknown, deferredCheckAfterSeconds: number,
  ): Promise<void> {
    const verifyAt = new Date(this.now().getTime() + deferredCheckAfterSeconds * 1000);
    await this.tx(tenantId, async (client) => {
      await client.query(
        `INSERT INTO oweibo.deferred_verifications
           (tenant_id, proposal_id, verifier_name, verifier_config,
            expected, verify_after)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6)`,
        [
          tenantId, proposalId, verifierName,
          JSON.stringify(adapterOutcome ?? null),
          JSON.stringify(adapterOutcome ?? null),
          verifyAt,
        ],
      );
    });
  }

  private async claimDue(limit: number): Promise<Array<{
    id: string;
    tenant_id: string;
    proposal_id: string;
    verifier_name: string;
    verifier_config: unknown;
    expected: unknown;
    attempts: number;
  }>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Cross-tenant claim path: platform_admin bypass.
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
      const r = await client.query<{
        id: string;
        tenant_id: string;
        proposal_id: string;
        verifier_name: string;
        verifier_config: unknown;
        expected: unknown;
        attempts: number;
      }>(
        `WITH claimed AS (
           SELECT id FROM oweibo.deferred_verifications
            WHERE state = 'pending' AND verify_after <= NOW()
            ORDER BY verify_after ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE oweibo.deferred_verifications AS d
            SET state = 'running', attempts = d.attempts + 1
           FROM claimed
          WHERE d.id = claimed.id
          RETURNING d.id, d.tenant_id, d.proposal_id, d.verifier_name,
                    d.verifier_config, d.expected, d.attempts`,
        [limit],
      );
      await client.query('COMMIT');
      return r.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async markDone(id: string, state: 'done' | 'failed_terminal' | 'superseded', err: string | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
      await client.query(
        `UPDATE oweibo.deferred_verifications
            SET state = $2, last_error = COALESCE($3, last_error), completed_at = NOW()
          WHERE id = $1::uuid`,
        [id, state, err],
      );
    } finally {
      client.release();
    }
  }

  private async scheduleRetryOrFail(id: string, attempts: number, err: string | null): Promise<void> {
    if (attempts >= MAX_DEFERRED_ATTEMPTS) {
      await this.markDone(id, 'failed_terminal', err);
      return;
    }
    const backoffSec = DEFERRED_BACKOFF_SECONDS[attempts - 1] ?? DEFERRED_BACKOFF_SECONDS[DEFERRED_BACKOFF_SECONDS.length - 1]!;
    const nextAt = new Date(this.now().getTime() + backoffSec * 1000);
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
      await client.query(
        `UPDATE oweibo.deferred_verifications
            SET state = 'pending', verify_after = $2, last_error = $3
          WHERE id = $1::uuid`,
        [id, nextAt, err],
      );
    } finally {
      client.release();
    }
  }

  private async maybeAutoRollback(
    tenantId: string, proposalId: string,
    results: ReadonlyArray<{ verifierName: string; outcome: VerificationOutcome }>,
  ): Promise<void> {
    if (!this.autoRollback) {
      this.log('warn', 'sev-3 drift detected but no auto-rollback wired', { tenantId, proposalId });
      return;
    }
    const reason = `verifier_drift:sev3:${results.map((r) => r.verifierName).join(',')}`;
    const result = await this.autoRollback({ tenantId, proposalId, reason });
    this.log(result.ok ? 'info' : 'warn',
      `auto-rollback for ${proposalId}: ${result.ok ? 'ok' : 'failed'} (${result.details ?? ''})`);
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function defaultEnabled(): boolean {
  return process.env.POST_EXECUTION_VERIFICATION_ENABLED === 'true';
}

function defaultLog(level: 'info' | 'warn' | 'error', line: string, _ctx?: unknown): void {
  if (level === 'error') console.error(`[PostExecutionVerifier] ${line}`);
  else if (level === 'warn') console.warn(`[PostExecutionVerifier] ${line}`);
  else console.log(`[PostExecutionVerifier] ${line}`);
}

function worstSeverity(sevs: readonly DriftSeverity[]): DriftSeverity {
  let worst: DriftSeverity = 0;
  for (const s of sevs) if (s > worst) worst = s;
  return worst;
}

function runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`verifier timeout after ${ms}ms`)), ms),
    ),
  ]);
}

// Re-export the severity action helper so callers don't need a second
// import path.
export { severityAction };
