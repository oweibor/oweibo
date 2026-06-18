/**
 * F.1.4 — RedisTaskEventBusPublisher.
 *
 * Implements `ITaskEventBusPublisher` from the approval-lifecycle-worker
 * (apps/approval-lifecycle-worker/src/Worker.ts). The worker calls
 * `taskEventBus.publish(...)` whenever an approval decision lands so that
 * subscriber tasks waiting on the proposal can wake up promptly.
 *
 * Wire format
 * ───────────
 *   Channel: `oweibo.task.events.v1`
 *   Body (UTF-8 JSON):
 *     {
 *       "subject":       "task.approval.decided.v1",
 *       "publishedAtMs": <number>,
 *       "payload": {
 *         "tenantId":          "<uuid>",
 *         "proposalId":        "<uuid>",
 *         "originatingTaskId": "<uuid|null>",
 *         "actionId":          "<uuid>",
 *         "actionClass":       "<slug>",
 *         "decision":          "approved" | "rejected" | "expired" | "auto_promoted_via_grant",
 *         "decidedByUserId":   "<uuid|undefined>",
 *         "reason":            "<string|undefined>",
 *         "decidedAtMs":       <number>
 *       }
 *     }
 *
 * The body shape is forward-compatible: subscribers MUST switch on
 * `subject` and tolerate unknown subjects (skip). New event kinds get a
 * new subject and a new payload type; the channel stays the same.
 *
 * Delivery guarantees
 * ───────────────────
 *   Lossy pub/sub via Redis PUBLISH. Subscribers that are not connected at
 *   publish time will NEVER receive the event. This matches the behaviour
 *   of OutboxRelay today and is mitigated by F.6 (XADD + consumer groups).
 *   Until F.6 lands, treat task wake-ups as "best-effort" — the worker tick
 *   plus the in-DB FSM still drive correctness.
 *
 * Failure handling
 * ───────────────
 *   publish() never throws. A Redis disconnect or PUBLISH error is logged
 *   via `opts.onError` (default: console.warn) and dropped. The upstream
 *   approval decision is already persisted in `oweibo.approval_sla_state`
 *   before the worker calls publish() — losing the wake-up does NOT lose
 *   the decision.
 */
/**
 * Structural mirror of the worker's ITaskEventBusPublisher
 * (apps/approval-lifecycle-worker/src/Worker.ts). The worker accepts any
 * object with this shape via the `taskEventBus` optional dependency;
 * importing the named interface from the worker package would create a
 * circular dep (worker is an app, not a library), so the shape lives here.
 *
 * Keep this shape in lockstep with the worker. A drift here surfaces at
 * the wiring site in main.ts as a TS error — that's the intended seam.
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

export const TASK_EVENT_BUS_CHANNEL = 'oweibo.task.events.v1';
export const TASK_APPROVAL_DECIDED_V1_SUBJECT = 'task.approval.decided.v1';

/**
 * The minimal Redis-publish shape the publisher needs. Matches the `rPub`
 * adapter constructed in main.ts; keeps the dep surface narrow and lets
 * tests inject a stub without standing up a full IORedis client.
 */
export type RedisPublishFn = (channel: string, message: string) => Promise<void>;

export interface RedisTaskEventBusPublisherOptions {
  /**
   * Invoked on publish failure. Defaults to console.warn. Never thrown
   * back to the caller — wake-up loss is logged, not propagated.
   */
  readonly onError?: (err: unknown, ctx: { tenantId: string; proposalId: string }) => void;
  /** Override clock; tests pin time. */
  readonly now?: () => number;
}

interface TaskApprovalDecidedV1Payload {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly originatingTaskId: string | null;
  readonly actionId: string;
  readonly actionClass: string;
  readonly decision: 'approved' | 'rejected' | 'expired' | 'auto_promoted_via_grant';
  readonly decidedByUserId?: string;
  readonly reason?: string;
  readonly decidedAtMs: number;
}

interface TaskEventEnvelopeV1 {
  readonly subject: typeof TASK_APPROVAL_DECIDED_V1_SUBJECT;
  readonly publishedAtMs: number;
  readonly payload: TaskApprovalDecidedV1Payload;
}

export class RedisTaskEventBusPublisher implements ITaskEventBusPublisher {
  static readonly CHANNEL = TASK_EVENT_BUS_CHANNEL;

  private readonly onError: (err: unknown, ctx: { tenantId: string; proposalId: string }) => void;
  private readonly now: () => number;

  constructor(
    private readonly publishFn: RedisPublishFn,
    opts: RedisTaskEventBusPublisherOptions = {},
  ) {
    this.onError = opts.onError ?? defaultOnError;
    this.now = opts.now ?? (() => Date.now());
  }

  async publish(event: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly originatingTaskId: string | null;
    readonly actionId: string;
    readonly actionClass: string;
    readonly decision: 'approved' | 'rejected' | 'expired' | 'auto_promoted_via_grant';
    readonly decidedByUserId?: string;
    readonly reason?: string;
    readonly decidedAtMs: number;
  }): Promise<void> {
    const envelope: TaskEventEnvelopeV1 = {
      subject: TASK_APPROVAL_DECIDED_V1_SUBJECT,
      publishedAtMs: this.now(),
      payload: event,
    };
    try {
      await this.publishFn(TASK_EVENT_BUS_CHANNEL, JSON.stringify(envelope));
    } catch (err) {
      this.onError(err, { tenantId: event.tenantId, proposalId: event.proposalId });
    }
  }
}

function defaultOnError(err: unknown, ctx: { tenantId: string; proposalId: string }): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.warn(
    `[RedisTaskEventBusPublisher] publish failed for proposal=${ctx.proposalId} ` +
    `tenant=${ctx.tenantId}: ${msg}; task wake-up dropped`,
  );
}
