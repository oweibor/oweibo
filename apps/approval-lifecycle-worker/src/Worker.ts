/**
 * S.1: ApprovalLifecycleWorker — drives the approval-SLA FSM.
 *
 * Every tick (default 30 s):
 *   1. SELECT * FROM approval_sla_state WHERE next_action_at <= NOW()
 *      FOR UPDATE SKIP LOCKED LIMIT batchSize.
 *   2. For each due row:
 *      - Look up parent proposal + policy.
 *      - If proposal already decided → clear row & continue.
 *      - If NOW() >= hard_expire_at → auto-reject + fire 'expiry'.
 *      - Else if more escalation stages remain → resolve next stage's
 *        approvers, dispatch notifications, advance stage pointer.
 *      - Else → park at hard_expire_at; next firing will expire.
 *
 * Dependencies are injected (NotificationRouter, EscalationEngine,
 * ApprovalSlaService, audit sink) so the worker is unit-testable
 * without any live infra.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ApprovalSlaPolicy,
  FireEvent,
} from '@oweibo/core-contracts';
import {
  runDeferredVerificationsTick,
  type IDeferredVerificationRunner,
} from './handlers/deferredVerifications.js';

export interface IApprovalSlaService {
  resolvePolicy(tenantId: string, actionClass: string): Promise<ApprovalSlaPolicy>;
  advanceStage(args: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly newStage: number;
    readonly escalationDelaySeconds: number | null;
    readonly notifiedApprovers: readonly string[];
    readonly details?: unknown;
  }): Promise<void>;
}

export interface IEscalationEngine {
  resolveStage(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly policy: ApprovalSlaPolicy;
    readonly stage: number;
    readonly priorOrgNodeIds: readonly string[];
    readonly priorUserIds: readonly string[];
  }): Promise<{
    readonly approverUserIds: readonly string[];
    readonly orgNodeIds: readonly string[];
    readonly chainExhausted: boolean;
  }>;
}

export interface INotificationRouter {
  route(req: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly fireEvent: FireEvent;
    readonly title: string;
    readonly body: string;
    readonly linkPath?: string;
    readonly policy: ApprovalSlaPolicy;
    readonly recipients: readonly { readonly userId: string }[];
  }): Promise<{ readonly dispatched: number; readonly suppressed: number; readonly failed: number }>;
}

export interface WorkerLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/**
 * Audit-fix (S.1 TaskEventBus): typed bus seam. Worker imports only the
 * minimal shape it needs (publish) so it doesn't pull in core-engine
 * just to wake tasks. Production wires a distributed bus; tests inject
 * a stub.
 */
export interface ITaskEventBusPublisher {
  publish(event: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly originatingTaskId: string | null;
    readonly actionId: string;
    readonly actionClass: string;
    readonly decision: 'approved' | 'rejected' | 'expired' | 'auto_promoted_via_grant';
    readonly decidedByUserId?: string;
    readonly reason?: string;
    readonly decidedAtMs: number;
  }): Promise<void>;
}

export interface ApprovalLifecycleWorkerOptions {
  /** How many rows to claim per tick. Default 200. */
  batchSize?: number;
  /** Override clock; tests pin time. */
  now?: () => Date;
  logger?: WorkerLogger;
  isEnabled?: () => boolean;
  /**
   * S.5.b: optional deferred-verification runner. When wired, the worker
   * runs a deferred-verification batch AFTER its approval-SLA loop on
   * each tick. When omitted, the verification path is dormant and the
   * worker behaves exactly as it did pre-S.5.
   */
  deferredVerificationRunner?: IDeferredVerificationRunner;
  /** Per-tick batch size for deferred verifications; default 100. */
  deferredVerificationBatchSize?: number;
  /**
   * Audit-fix (S.1 TaskEventBus): optional task event bus. When wired,
   * the worker publishes a `decision` event whenever a proposal is
   * auto-rejected (hard expiry) so the originating agent task can wake
   * up and react. When omitted, the auto-reject still happens — the
   * agent just doesn't get a wake signal until it polls.
   */
  taskEventBus?: ITaskEventBusPublisher;
}

interface DueRow {
  proposal_id: string;
  tenant_id: string;
  current_stage: number;
  hard_expire_at: Date;
  notified_approvers: string[];
}

interface ProposalRow {
  id: string;
  state: string;
  action_class: string;
  user_id: string | null;
  summary: string;
  // Audit-fix: read action_id + originating_task_id so the worker can
  // publish a TaskEventBus event when the proposal expires.
  action_id: string;
  originating_task_id: string | null;
}

const DEFAULT_BATCH_SIZE = 200;

export class ApprovalLifecycleWorker {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly logger: WorkerLogger;
  private readonly isEnabled: () => boolean;
  private readonly deferredVerificationRunner: IDeferredVerificationRunner | undefined;
  private readonly deferredVerificationBatchSize: number;
  private readonly taskEventBus: ITaskEventBusPublisher | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly sla: IApprovalSlaService,
    private readonly escalation: IEscalationEngine,
    private readonly router: INotificationRouter,
    opts: ApprovalLifecycleWorkerOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? defaultLogger;
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.deferredVerificationRunner = opts.deferredVerificationRunner;
    this.deferredVerificationBatchSize = opts.deferredVerificationBatchSize ?? 100;
    this.taskEventBus = opts.taskEventBus;
  }

  async runOnce(): Promise<{ processed: number; expired: number; escalated: number; skipped: number; deferredVerified: number }> {
    if (!this.isEnabled()) {
      return { processed: 0, expired: 0, escalated: 0, skipped: 0, deferredVerified: 0 };
    }
    let processed = 0;
    let expired = 0;
    let escalated = 0;
    let skipped = 0;

    const due = await this.claimDue();
    for (const row of due) {
      try {
        const outcome = await this.processRow(row);
        processed += 1;
        if (outcome === 'expired') expired += 1;
        else if (outcome === 'escalated') escalated += 1;
        else skipped += 1;
      } catch (err) {
        this.logger.error('ApprovalLifecycleWorker: processRow threw', {
          proposalId: row.proposal_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // S.5.b: run a deferred-verification batch on the same tick. Failures
    // are isolated by the handler — they never affect the SLA loop above.
    const deferred = await runDeferredVerificationsTick(this.deferredVerificationRunner, {
      batchSize: this.deferredVerificationBatchSize,
      log: (m, c) => this.logger.info(m, c as Record<string, unknown> | undefined),
    });

    return { processed, expired, escalated, skipped, deferredVerified: deferred.processed };
  }

  private async claimDue(): Promise<readonly DueRow[]> {
    const client = await this.pool.connect();
    try {
      // Platform-admin scope so the worker can see across tenants.
      await client.query(`SET LOCAL app.is_platform_admin = 'true'`);
      const r = await client.query<DueRow>(
        `SELECT proposal_id, tenant_id, current_stage, hard_expire_at, notified_approvers
           FROM oweibo.approval_sla_state
          WHERE next_action_at <= NOW()
          ORDER BY next_action_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [this.batchSize],
      );
      return r.rows;
    } finally {
      client.release();
    }
  }

  private async processRow(row: DueRow): Promise<'expired' | 'escalated' | 'skipped'> {
    const proposal = await this.loadProposal(row.tenant_id, row.proposal_id);
    if (!proposal || proposal.state !== 'pending') {
      await this.clearState(row.tenant_id, row.proposal_id);
      return 'skipped';
    }
    const policy = await this.sla.resolvePolicy(row.tenant_id, proposal.action_class);
    const now = this.now();

    // Hard-expiry path.
    if (now.getTime() >= row.hard_expire_at.getTime()) {
      await this.expireProposal(row, proposal, policy);
      return 'expired';
    }

    // Escalation path.
    const stages = policy.escalateAfterSeconds;
    if (row.current_stage > stages.length) {
      // Beyond the last stage but not yet at hard_expire — park.
      await this.parkUntilExpiry(row);
      return 'skipped';
    }

    const stage = row.current_stage;
    const escResult = await this.escalation.resolveStage({
      tenantId: row.tenant_id,
      actionClass: proposal.action_class,
      policy,
      stage,
      priorOrgNodeIds: [], // worker doesn't persist these between ticks (S.1 keeps it simple)
      priorUserIds: row.notified_approvers,
    });

    if (escResult.approverUserIds.length === 0) {
      // No one to notify — park until hard_expire.
      await this.parkUntilExpiry(row);
      return 'skipped';
    }

    const fireEvent: FireEvent = stage === 0 ? 'initial' : (`escalation:${stage}` as const);
    await this.router.route({
      tenantId: row.tenant_id,
      proposalId: row.proposal_id,
      fireEvent,
      title: `Approval needed: ${proposal.summary}`.slice(0, 200),
      body: `Action class ${proposal.action_class} awaiting approval.`,
      linkPath: `/t/${row.tenant_id}/actions/pending`,
      policy,
      recipients: escResult.approverUserIds.map((userId) => ({ userId })),
    });

    const nextDelay = stages[stage] ?? null;
    await this.sla.advanceStage({
      tenantId: row.tenant_id,
      proposalId: row.proposal_id,
      newStage: stage + 1,
      escalationDelaySeconds: nextDelay,
      notifiedApprovers: escResult.approverUserIds,
      details: { fireEvent, approverCount: escResult.approverUserIds.length },
    });
    return 'escalated';
  }

  private async expireProposal(
    row: DueRow,
    proposal: ProposalRow,
    policy: ApprovalSlaPolicy,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(row.tenant_id)) {
        await client.query(`SET LOCAL app.tenant_id = '${row.tenant_id}'`);
      }
      await client.query(
        `UPDATE oweibo.action_proposals
            SET state = 'expired',
                decision_reason = 'sla_expired',
                decided_at = NOW()
          WHERE id = $1::uuid AND state = 'pending'`,
        [row.proposal_id],
      );
      await client.query(
        `DELETE FROM oweibo.approval_sla_state WHERE proposal_id = $1::uuid`,
        [row.proposal_id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // Audit-fix (S.1 TaskEventBus): publish a wake event so the
    // originating agent task can resume. Best-effort — publish failure
    // MUST NOT block the expire path. The proposal state in Postgres
    // remains the source of truth; the wake event is just a latency
    // optimization over the agent's polling fallback.
    if (this.taskEventBus && proposal.originating_task_id) {
      try {
        await this.taskEventBus.publish({
          tenantId: row.tenant_id,
          proposalId: row.proposal_id,
          originatingTaskId: proposal.originating_task_id,
          actionId: proposal.action_id,
          actionClass: proposal.action_class,
          decision: 'expired',
          reason: 'sla_expired',
          decidedAtMs: this.now().getTime(),
        });
      } catch (err) {
        this.logger.warn('taskEventBus.publish threw on expire', {
          proposalId: row.proposal_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Best-effort expiry notification (urgent bypasses quiet hours).
    const recipients: { userId: string }[] = [];
    if (proposal.user_id) recipients.push({ userId: proposal.user_id });
    for (const u of row.notified_approvers) recipients.push({ userId: u });
    if (recipients.length > 0) {
      await this.router.route({
        tenantId: row.tenant_id,
        proposalId: row.proposal_id,
        fireEvent: 'expiry',
        title: `Approval expired: ${proposal.summary}`.slice(0, 200),
        body: `Approval for ${proposal.action_class} expired without a decision; the action was auto-rejected.`,
        linkPath: `/t/${row.tenant_id}/actions/pending`,
        policy,
        recipients,
      }).catch(() => undefined);
    }
  }

  private async parkUntilExpiry(row: DueRow): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(row.tenant_id)) {
        await client.query(`SET LOCAL app.tenant_id = '${row.tenant_id}'`);
      }
      await client.query(
        `UPDATE oweibo.approval_sla_state
            SET next_action_at = hard_expire_at
          WHERE proposal_id = $1::uuid`,
        [row.proposal_id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async clearState(tenantId: string, proposalId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      await client.query(
        `DELETE FROM oweibo.approval_sla_state WHERE proposal_id = $1::uuid`,
        [proposalId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
  }

  private async loadProposal(tenantId: string, proposalId: string): Promise<ProposalRow | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      const r = await client.query<ProposalRow>(
        `SELECT id, state, action_class, user_id, summary,
                action_id, originating_task_id
           FROM oweibo.action_proposals
          WHERE id = $1::uuid`,
        [proposalId],
      );
      await client.query('COMMIT');
      return r.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return null;
    } finally {
      client.release();
    }
  }
}

function defaultEnabled(): boolean {
  return process.env.APPROVAL_SLA_WORKER_ENABLED === 'true';
}

const defaultLogger: WorkerLogger = {
  info: (m, e) => console.log(`[approval-lifecycle] ${m}`, e ?? ''),
  warn: (m, e) => console.warn(`[approval-lifecycle] ${m}`, e ?? ''),
  error: (m, e) => console.error(`[approval-lifecycle] ${m}`, e ?? ''),
};

export type { PoolClient };
