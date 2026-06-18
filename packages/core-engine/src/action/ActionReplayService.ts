/**
 * S.7: ActionReplayService — re-walks a plan's decision chain WITHOUT
 * invoking real adapter execute() calls. Three replay kinds:
 *
 *   * `shadow_full` — re-run every step in shadow mode; compare each
 *     replayed decision against the original.
 *   * `shadow_step` — re-run a single proposal (by id).
 *   * `what_if`    — re-run with a single parameter mutated (e.g. an
 *     alternate accountAgeDays in calibrationSnapshot).
 *
 * Hard separation guarantee: this service NEVER calls
 * adapter.execute(). It only re-runs the gate logic. The injected
 * `replayGate` function is the only seam — production wires it to a
 * sandboxed ActionTrustLadder that has no rollback / external connectors
 * registered. Tests inject a deterministic stub.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ReplayKind,
  ReplayMutation,
  ReplayRequest,
  ReplayResult,
  ReplayStepResult,
} from '@oweibo/core-contracts';

export interface ReplayInputProposal {
  readonly proposalId: string;
  readonly actionClass: string;
  readonly actionId: string;
  readonly mode: 'dry_run' | 'shadow' | 'require_approval';
  readonly state: string;
  readonly summary: string;
  readonly payload: unknown;
  /** Originating user id; threaded back into the replay context. */
  readonly userId: string | null;
}

/**
 * The shadow-only gate seam. The production wire bridges this to a
 * dedicated ActionTrustLadder instance whose `isShadowOnly()` returns
 * true and whose rollback / connector registries are empty. The
 * implementation may use the proposal's `payload` and any provided
 * mutation to derive the replayed decision.
 */
export interface IReplayGate {
  decide(input: {
    readonly tenantId: string;
    readonly proposal: ReplayInputProposal;
    readonly mutation?: ReplayMutation;
  }): Promise<{ replayedMode: string; notes?: string }>;
}

export interface ActionReplayServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', line: string, ctx?: unknown) => void;
}

export class ActionReplayService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly log: NonNullable<ActionReplayServiceOptions['log']>;

  constructor(
    private readonly pool: Pool,
    private readonly replayGate: IReplayGate,
    opts: ActionReplayServiceOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? defaultLog;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Queue a replay run and execute it inline. (For large plans we could
   * push this to a worker; current scope runs synchronously.) Returns
   * the resulting ReplayResult.
   */
  async replay(req: ReplayRequest): Promise<ReplayResult> {
    if (!this.isEnabled()) {
      throw new Error('ActionReplayService: forensic_replay.enabled is off');
    }
    // 1. Insert action_replay_runs row in 'queued' → flip to 'running'.
    const runId = await this.openRun(req);
    try {
      const proposals = await this.loadProposals(req.tenantId, req.planId, req.proposalId, req.kind);
      const stepResults: ReplayStepResult[] = [];
      for (const p of proposals) {
        const gateInput = req.mutation
          ? { tenantId: req.tenantId, proposal: p, mutation: req.mutation }
          : { tenantId: req.tenantId, proposal: p };
        let replayed: { replayedMode: string; notes?: string };
        try {
          replayed = await this.replayGate.decide(gateInput);
        } catch (err) {
          replayed = {
            replayedMode: '<gate_error>',
            notes: err instanceof Error ? err.message : String(err),
          };
        }
        const stepResult: ReplayStepResult = {
          proposalId: p.proposalId,
          actionClass: p.actionClass,
          originalDecision: p.mode,
          replayedDecision: replayed.replayedMode,
          matches: replayed.replayedMode === p.mode,
          ...(replayed.notes ? { notes: replayed.notes } : {}),
        };
        stepResults.push(stepResult);
      }
      const matching = stepResults.filter((s) => s.matches).length;
      const result: ReplayResult = {
        runId,
        status: 'complete',
        stepResults,
        totalSteps: stepResults.length,
        matchingSteps: matching,
        mismatchSteps: stepResults.length - matching,
      };
      await this.closeRun(req.tenantId, runId, 'complete', null, result);
      return result;
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      await this.closeRun(req.tenantId, runId, 'failed', failureReason, null);
      this.log('warn', `replay ${runId} failed: ${failureReason}`);
      return {
        runId,
        status: 'failed',
        stepResults: [],
        totalSteps: 0,
        matchingSteps: 0,
        mismatchSteps: 0,
        failureReason,
      };
    }
  }

  // ── Reads (F.4.1: replay-run status endpoint) ──────────────────────────

  /**
   * Returns the row + summarized result for a replay run, or null when
   * the run id is unknown / belongs to another tenant. Used by
   * `GET /forensics/:id/replay/:runId`.
   */
  async getRun(tenantId: string, runId: string): Promise<ReplayRunSummary | null> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<{
        id: string;
        plan_id: string;
        requested_by: string;
        replay_kind: string;
        mutation: unknown;
        result_summary: unknown;
        status: string;
        failure_reason: string | null;
        started_at: Date | null;
        completed_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, plan_id, requested_by, replay_kind, mutation,
                result_summary, status, failure_reason,
                started_at, completed_at, created_at
           FROM oweibo.action_replay_runs
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [runId, tenantId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        runId: row.id,
        planId: row.plan_id,
        requestedBy: row.requested_by,
        kind: row.replay_kind as ReplayKind,
        mutation: row.mutation as ReplayMutation | null,
        status: row.status as 'queued' | 'running' | 'complete' | 'failed',
        failureReason: row.failure_reason,
        resultSummary: row.result_summary as Record<string, unknown> | null,
        startedAt: row.started_at ? row.started_at.toISOString() : null,
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async openRun(req: ReplayRequest): Promise<string> {
    return this.tx(req.tenantId, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO oweibo.action_replay_runs
           (tenant_id, plan_id, requested_by, replay_kind, mutation,
            status, started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'running', NOW())
         RETURNING id`,
        [
          req.tenantId, req.planId, req.requestedByUserId, req.kind,
          req.mutation ? JSON.stringify(req.mutation) : null,
        ],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('openRun: insert returned no id');
      return id;
    });
  }

  private async closeRun(
    tenantId: string, runId: string,
    status: 'complete' | 'failed',
    failureReason: string | null,
    result: ReplayResult | null,
  ): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `UPDATE oweibo.action_replay_runs
            SET status = $2,
                failure_reason = $3,
                result_summary = $4::jsonb,
                completed_at = NOW()
          WHERE id = $1::uuid`,
        [runId, status, failureReason, result ? JSON.stringify(summarizeResult(result)) : null],
      );
    });
  }

  private async loadProposals(
    tenantId: string,
    planId: string,
    proposalId: string | undefined,
    kind: ReplayKind,
  ): Promise<ReplayInputProposal[]> {
    return this.tx(tenantId, async (client) => {
      let rows;
      if (kind === 'shadow_step' && proposalId) {
        rows = await client.query<{
          id: string;
          action_class: string;
          action_id: string;
          mode: string;
          state: string;
          summary: string;
          payload: unknown;
          user_id: string | null;
        }>(
          `SELECT id, action_class, action_id, mode, state, summary, payload, user_id
             FROM oweibo.action_proposals
            WHERE id = $1::uuid AND plan_id = $2::uuid`,
          [proposalId, planId],
        );
      } else {
        rows = await client.query<{
          id: string;
          action_class: string;
          action_id: string;
          mode: string;
          state: string;
          summary: string;
          payload: unknown;
          user_id: string | null;
        }>(
          `SELECT id, action_class, action_id, mode, state, summary, payload, user_id
             FROM oweibo.action_proposals
            WHERE plan_id = $1::uuid
            ORDER BY created_at ASC`,
          [planId],
        );
      }
      // F.0: `let rows;` above leaves the type as the union of two
      // branches; TS treats it as untyped, so map<T>() rejects the
      // type argument. Spell the result type via a local annotation
      // instead.
      const out: ReplayInputProposal[] = rows.rows.map((r) => ({
        proposalId: r.id,
        actionClass: r.action_class,
        actionId: r.action_id,
        mode: r.mode as ReplayInputProposal['mode'],
        state: r.state,
        summary: r.summary,
        payload: r.payload,
        userId: r.user_id,
      }));
      return out;
    });
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
  return process.env.FORENSIC_REPLAY_ENABLED === 'true';
}

function defaultLog(level: 'info' | 'warn' | 'error', line: string, _ctx?: unknown): void {
  if (level === 'error') console.error(`[ActionReplay] ${line}`);
  else if (level === 'warn') console.warn(`[ActionReplay] ${line}`);
  else console.log(`[ActionReplay] ${line}`);
}

export interface ReplayRunSummary {
  readonly runId: string;
  readonly planId: string;
  readonly requestedBy: string;
  readonly kind: ReplayKind;
  readonly mutation: ReplayMutation | null;
  readonly status: 'queued' | 'running' | 'complete' | 'failed';
  readonly failureReason: string | null;
  readonly resultSummary: Record<string, unknown> | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

/**
 * Trim a ReplayResult to the rolled-up summary stored in
 * action_replay_runs.result_summary. Full step details live in the
 * caller's response object only.
 */
function summarizeResult(result: ReplayResult): Record<string, unknown> {
  return {
    runId: result.runId,
    totalSteps: result.totalSteps,
    matchingSteps: result.matchingSteps,
    mismatchSteps: result.mismatchSteps,
    mismatchExamples: result.stepResults
      .filter((s) => !s.matches)
      .slice(0, 5)
      .map((s) => ({
        proposalId: s.proposalId,
        actionClass: s.actionClass,
        original: s.originalDecision,
        replayed: s.replayedDecision,
      })),
  };
}
