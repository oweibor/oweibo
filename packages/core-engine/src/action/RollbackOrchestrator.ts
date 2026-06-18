/**
 * S.3: RollbackOrchestrator — drives the actual rollback execution.
 *
 * Flow per `execute(actionId, reason, invokedBy)`:
 *   1. Load the original action_proposal; assert state ∈ {executed_live, executed_shadow}.
 *   2. Refuse if action_class starts with `recovery.rollback.` (rolling back
 *      a rollback is forbidden — closes the infinite-recursion risk).
 *   3. Load RollbackEnvelope; refuse if kind === 'irreversible'.
 *   4. Resolve adapter from registry by envelope.adapterName (or
 *      `details` if pre-S.3 envelopes lack the name); refuse if missing.
 *   5. Write `rollback_executions` row in 'started' state (no result_state yet).
 *   6. Run adapter.preflight(); abort with adapter-thrown error on failure.
 *   7. Run adapter.execute() under per-adapter timeout.
 *   8. Update `rollback_executions` row with result.
 *   9. Update original action_proposal.state to `rolled_back` (success) or
 *      `rollback_failed` (failure).
 *  10. Return the RollbackResult.
 *
 * Failure modes (each logged and returned, never thrown):
 *   - adapter missing      → result_state='failed', proposal unchanged
 *   - preflight throws     → result_state='failed', proposal unchanged
 *   - execute throws       → result_state='failed', proposal.state='rollback_failed'
 *   - execute returns failed → result_state='failed', proposal.state='rollback_failed'
 *   - execute returns success → result_state matches, proposal.state='rolled_back'
 */
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackInvokerType,
  RollbackResult,
} from '@oweibo/core-contracts';

/** Pluggable adapter registry. The orchestrator looks adapters up by name. */
export class RollbackAdapterRegistry {
  private readonly adapters = new Map<string, IRollbackAdapter>();

  register(adapter: IRollbackAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  resolve(name: string): IRollbackAdapter | undefined {
    return this.adapters.get(name);
  }

  names(): readonly string[] {
    return Array.from(this.adapters.keys()).sort();
  }
}

export interface RollbackOrchestratorOptions {
  isEnabled?: () => boolean;
  /** Per-adapter execute() timeout in ms. Default 60_000. */
  executeTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
  /**
   * S.5.b: optional hook called when a proposal is successfully rolled
   * back so any pending deferred verifications can be marked
   * `superseded` (verifying a rolled-back action is meaningless).
   * Best-effort — failure to supersede MUST NOT fail the rollback.
   */
  onRollbackSuccess?: (args: {
    readonly tenantId: string;
    readonly proposalId: string;
  }) => Promise<void>;
}

export interface RollbackInvokeRequest {
  readonly tenantId: string;
  readonly originalActionId: string;
  readonly reason: string;
  readonly invokedBy: { readonly type: RollbackInvokerType; readonly id: string };
}

export interface RollbackStatus {
  readonly executionId: string;
  readonly adapterName: string;
  readonly reason: string;
  readonly invokedBy: { readonly type: string; readonly id: string };
  readonly resultState: string | null;
  readonly resultDetails: string | null;
  readonly sideEffects: readonly string[];
  readonly costUsdCents: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

interface ProposalRow {
  id: string;
  tenant_id: string;
  action_class: string;
  state: string;
  rollback_kind: string | null;
  rollback_detail: unknown;
  plan_id: string | null;
}

/**
 * S.3 envelope persistence shape on `action_proposals.rollback_detail`.
 * T.−1 stored the bare `RollbackEnvelope`; S.3 layers an optional
 * `adapterName` so the orchestrator can route to the right adapter without
 * scanning every connector. Adapters that already shipped without
 * persisting the name fall back to `details` matching by convention.
 */
type PersistedEnvelope = RollbackEnvelope & { readonly adapterName?: string };

export class RollbackOrchestrator {
  private readonly isEnabled: () => boolean;
  private readonly executeTimeoutMs: number;
  private readonly log: NonNullable<RollbackOrchestratorOptions['log']>;
  private readonly now: () => Date;
  private readonly onRollbackSuccess: RollbackOrchestratorOptions['onRollbackSuccess'];

  constructor(
    private readonly pool: Pool,
    private readonly registry: RollbackAdapterRegistry,
    opts: RollbackOrchestratorOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.executeTimeoutMs = opts.executeTimeoutMs ?? 60_000;
    this.log = opts.log ?? defaultLog;
    this.onRollbackSuccess = opts.onRollbackSuccess;
    this.now = opts.now ?? (() => new Date());
  }

  async execute(req: RollbackInvokeRequest): Promise<RollbackResult> {
    if (!this.isEnabled()) {
      return failed('rollback_execution.enabled flag is off');
    }

    const proposal = await this.loadProposal(req.tenantId, req.originalActionId);
    if (!proposal) {
      return failed('original action not found');
    }
    if (proposal.action_class.startsWith('recovery.rollback.')) {
      return failed('cannot roll back a rollback action');
    }
    if (proposal.state !== 'executed_live' && proposal.state !== 'executed_shadow') {
      return failed(`original action is in state ${proposal.state}; can only roll back executed actions`);
    }

    const envelope = parseEnvelope(proposal.rollback_kind, proposal.rollback_detail);
    if (!envelope) {
      return failed('no rollback envelope captured on original action');
    }
    if (envelope.kind === 'irreversible') {
      return failed('action declared irreversible; no rollback possible');
    }

    const adapterName = envelope.adapterName ?? deriveAdapterName(proposal.action_class);
    const adapter = adapterName ? this.registry.resolve(adapterName) : undefined;
    if (!adapter) {
      return failed(`no rollback adapter registered for ${adapterName ?? '(unknown)'}`);
    }

    const ctx: RollbackContext = {
      tenantId: req.tenantId,
      originalActionId: proposal.id,
      originalPlanId: proposal.plan_id,
      invokedBy: req.invokedBy,
      correlationId: randomUUID(),
    };

    // Start the execution row first so a crash mid-execute leaves a
    // diagnostic record of what was attempted.
    const executionId = await this.writeStartRow({
      tenantId: req.tenantId,
      originalActionId: proposal.id,
      adapterName: adapter.name,
      reason: req.reason,
      invokedBy: req.invokedBy,
    });

    try {
      await adapter.preflight(envelope, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.completeExecution(executionId, req.tenantId, {
        success: false,
        state: 'failed',
        details: `preflight failed: ${message}`,
        sideEffects: [],
        costUsdCents: 0,
      }, /* updateProposalToRollbackFailed */ false);
      return { success: false, state: 'failed', details: `preflight failed: ${message}`, sideEffects: [], costUsdCents: 0 };
    }

    let result: RollbackResult;
    try {
      result = await withTimeout(adapter.execute(envelope, ctx), this.executeTimeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { success: false, state: 'failed', details: `execute threw: ${message}`, sideEffects: [], costUsdCents: 0 };
    }

    await this.completeExecution(executionId, req.tenantId, result, /* updateProposalToRollbackFailed */ !result.success);
    if (result.success) {
      await this.markProposal(req.tenantId, proposal.id, 'rolled_back');
      // S.5.b: mark any pending deferred verifications for this proposal
      // as superseded. Best-effort — never fail the rollback if this hook
      // throws (e.g. transient DB blip).
      if (this.onRollbackSuccess) {
        try {
          await this.onRollbackSuccess({ tenantId: req.tenantId, proposalId: proposal.id });
        } catch (err) {
          this.log('warn', `onRollbackSuccess hook threw for ${proposal.id}`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return result;
  }

  /**
   * F.4.3: read the most-recent rollback execution row for an original
   * action. Returns null when no rollback has been invoked. Used by
   * `GET /tenants/:tenantId/actions/:id/rollback/status` so an operator
   * who fired execute can poll its progress until completed_at is set.
   */
  async getStatus(
    tenantId: string,
    originalActionId: string,
  ): Promise<RollbackStatus | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const r = await client.query<{
        id: string;
        adapter_name: string;
        reason: string;
        invoked_by_type: string;
        invoked_by_id: string;
        result_state: string | null;
        result_details: string | null;
        side_effects: string[] | null;
        cost_usd_cents: number | null;
        started_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT id, adapter_name, reason, invoked_by_type, invoked_by_id,
                result_state, result_details, side_effects, cost_usd_cents,
                started_at, completed_at
           FROM oweibo.rollback_executions
          WHERE original_action_id = $1::uuid AND tenant_id = $2::uuid
          ORDER BY started_at DESC
          LIMIT 1`,
        [originalActionId, tenantId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        executionId: row.id,
        adapterName: row.adapter_name,
        reason: row.reason,
        invokedBy: { type: row.invoked_by_type, id: row.invoked_by_id },
        resultState: row.result_state,
        resultDetails: row.result_details,
        sideEffects: row.side_effects ?? [],
        costUsdCents: row.cost_usd_cents ?? 0,
        startedAt: row.started_at.toISOString(),
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      };
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async loadProposal(tenantId: string, actionId: string): Promise<ProposalRow | null> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const r = await client.query<ProposalRow>(
        `SELECT id, tenant_id, action_class, state, rollback_kind, rollback_detail, plan_id
           FROM oweibo.action_proposals
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [actionId, tenantId],
      );
      return r.rows[0] ?? null;
    });
  }

  private async writeStartRow(args: {
    readonly tenantId: string;
    readonly originalActionId: string;
    readonly adapterName: string;
    readonly reason: string;
    readonly invokedBy: { readonly type: RollbackInvokerType; readonly id: string };
  }): Promise<string> {
    return withTenantTx(this.pool, args.tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO oweibo.rollback_executions
           (tenant_id, original_action_id, adapter_name, reason,
            invoked_by_type, invoked_by_id, started_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [args.tenantId, args.originalActionId, args.adapterName, args.reason,
         args.invokedBy.type, args.invokedBy.id],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('writeStartRow: insert returned no id');
      return id;
    });
  }

  private async completeExecution(
    executionId: string,
    tenantId: string,
    result: RollbackResult,
    updateProposalToRollbackFailed: boolean,
  ): Promise<void> {
    await withTenantTx(this.pool, tenantId, async (client) => {
      await client.query(
        `UPDATE oweibo.rollback_executions
            SET result_state   = $2,
                result_details = $3,
                side_effects   = $4::text[],
                cost_usd_cents = $5,
                completed_at   = NOW()
          WHERE id = $1::uuid`,
        [executionId, result.state, result.details, result.sideEffects, result.costUsdCents],
      );
    });
    if (updateProposalToRollbackFailed) {
      const original = await withTenantTx(this.pool, tenantId, async (client) => {
        const r = await client.query<{ original_action_id: string }>(
          `SELECT original_action_id FROM oweibo.rollback_executions WHERE id = $1::uuid`,
          [executionId],
        );
        return r.rows[0]?.original_action_id ?? null;
      });
      if (original) await this.markProposal(tenantId, original, 'rollback_failed');
    }
  }

  private async markProposal(tenantId: string, actionId: string, state: 'rolled_back' | 'rollback_failed'): Promise<void> {
    // Audit-fix: only transition from an executed state. A stale call
    // (e.g. after the row already moved to rolled_back via a concurrent
    // path) is a no-op, never a stomp. Also pin the tenant id.
    await withTenantTx(this.pool, tenantId, async (client) => {
      await client.query(
        `UPDATE oweibo.action_proposals
            SET state = $2
          WHERE id = $1::uuid
            AND tenant_id = $3::uuid
            AND state IN ('executed_live', 'executed_shadow')`,
        [actionId, state, tenantId],
      );
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function failed(details: string): RollbackResult {
  return { success: false, state: 'failed', details, sideEffects: [], costUsdCents: 0 };
}

function parseEnvelope(kind: string | null, detail: unknown): PersistedEnvelope | null {
  if (!kind) return null;
  if (kind !== 'trivial' && kind !== 'reversible_with_cost' && kind !== 'irreversible') return null;
  const details = typeof detail === 'object' && detail !== null
    ? (detail as Record<string, unknown>)
    : {};
  return {
    kind,
    details: typeof details['details'] === 'string' ? (details['details'] as string) : '',
    ...(details['rollbackPlan'] !== undefined ? { rollbackPlan: details['rollbackPlan'] } : {}),
    ...(typeof details['adapterName'] === 'string' ? { adapterName: details['adapterName'] as string } : {}),
  };
}

/**
 * Convention-based fallback when the persisted envelope doesn't carry an
 * explicit adapter name: derive from action_class prefix. e.g.
 *   write.tenant_db.prod        → postgres
 *   write.local.repo_prod       → git
 *   comm.external_message       → slack  (best guess; real wiring should use adapterName)
 *
 * Returns null if no convention matches — caller surfaces "no adapter"
 * error rather than picking a wrong one.
 */
function deriveAdapterName(actionClass: string): string | null {
  if (actionClass.startsWith('write.tenant_db.')) return 'postgres';
  if (actionClass.startsWith('write.local.repo_')) return 'git';
  if (actionClass.startsWith('comm.external_message')) return 'slack';
  if (actionClass.startsWith('write.external_api.')) return 'webhook';
  if (actionClass.startsWith('deploy.')) return 'deploy';
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`adapter timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function withTenantTx<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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

function defaultEnabled(): boolean {
  return process.env.ROLLBACK_EXECUTION_ENABLED === 'true';
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === 'error') console.error(`[RollbackOrchestrator] ${line}`);
  else if (level === 'warn') console.warn(`[RollbackOrchestrator] ${line}`);
  else console.log(`[RollbackOrchestrator] ${line}`);
}
