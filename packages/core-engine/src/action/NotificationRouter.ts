/**
 * S.1: NotificationRouter — dispatches a notification to the configured
 * channels with quiet-hour suppression, fallback to in-app, and per-
 * channel dispatch logging.
 *
 * Fan-out rules:
 *   - For each (recipient × channel) pair, attempt the channel.
 *   - If the channel returns 'failed' AND the recipient hasn't already
 *     been reached on any channel, queue a fallback in-app dispatch.
 *   - Quiet hours suppress non-urgent dispatches; urgent (expiry) bypasses.
 *   - Every dispatch attempt writes a row to notification_dispatch_log.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ApprovalSlaPolicy,
  DispatchResult,
  FireEvent,
  INotificationChannel,
  NotificationChannelKind,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';
import { isInQuietHours } from './ApprovalSlaService.js';

export interface NotificationRouterOptions {
  /** Map of channelKind → adapter. In-app is required; others optional. */
  channels: ReadonlyMap<NotificationChannelKind, INotificationChannel>;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

export interface RouteRequest {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly fireEvent: FireEvent;
  readonly title: string;
  readonly body: string;
  readonly linkPath?: string;
  readonly policy: ApprovalSlaPolicy;
  /** Per-recipient destinations. `userId` is the canonical key for in-app. */
  readonly recipients: readonly NotificationRecipient[];
}

export interface NotificationRecipient {
  readonly userId: string;
  /** Optional per-channel handle (slack id, email, webhook url). */
  readonly handles?: Partial<Record<NotificationChannelKind, string>>;
}

export interface RouteResult {
  readonly dispatched: number;
  readonly suppressed: number;
  readonly failed: number;
}

export class NotificationRouter {
  private readonly channels: ReadonlyMap<NotificationChannelKind, INotificationChannel>;
  private readonly now: () => Date;
  private readonly log: NonNullable<NotificationRouterOptions['log']>;

  constructor(private readonly pool: Pool, opts: NotificationRouterOptions) {
    this.channels = opts.channels;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => undefined);
  }

  async route(req: RouteRequest): Promise<RouteResult> {
    const urgency: 'normal' | 'urgent' = req.fireEvent === 'expiry' ? 'urgent' : 'normal';
    const inQuiet = urgency === 'normal' && isInQuietHours(this.now(), req.policy.quietHours);

    // Compute the channel set: each channel listed in policy.notificationChannels
    // whose `fireOn` includes the bucket of the current fireEvent.
    const bucket = fireEventBucket(req.fireEvent);
    const channelRefs = req.policy.notificationChannels.filter((c) => c.fireOn.includes(bucket));

    let dispatched = 0;
    let suppressed = 0;
    let failed = 0;

    for (const recipient of req.recipients) {
      let reached = false;
      for (const ref of channelRefs) {
        const adapter = this.channels.get(ref.channelKind);
        if (!adapter) continue;
        const handle = recipient.handles?.[ref.channelKind] ?? recipient.userId;
        const dispatchReq: NotificationDispatchRequest = {
          tenantId: req.tenantId,
          proposalId: req.proposalId,
          recipientUserId: recipient.userId,
          recipientHandle: handle,
          channelKind: ref.channelKind,
          fireEvent: req.fireEvent,
          title: req.title,
          body: req.body,
          urgency,
          ...(req.linkPath ? { linkPath: req.linkPath } : {}),
        };

        if (inQuiet) {
          await this.logDispatch({
            tenantId: req.tenantId,
            proposalId: req.proposalId,
            channelKind: ref.channelKind,
            recipient: handle,
            fireEvent: req.fireEvent,
            status: 'suppressed_quiet_hours',
          });
          suppressed += 1;
          continue;
        }

        let result: DispatchResult;
        try {
          result = await adapter.dispatch(dispatchReq);
        } catch (err) {
          result = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
        }
        await this.logDispatch({
          tenantId: req.tenantId,
          proposalId: req.proposalId,
          channelKind: ref.channelKind,
          recipient: handle,
          fireEvent: req.fireEvent,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        });

        if (result.status === 'sent' || result.status === 'delivered') {
          dispatched += 1;
          reached = true;
          break; // first successful channel per recipient wins.
        }
        if (result.status === 'failed') failed += 1;
      }

      // Fallback: if we haven't reached this recipient (e.g. all channels failed
      // or none configured) AND we have an in-app channel, always fire in-app.
      if (!reached && !inQuiet) {
        const inApp = this.channels.get('in_app');
        if (inApp) {
          try {
            const result = await inApp.dispatch({
              tenantId: req.tenantId,
              proposalId: req.proposalId,
              recipientUserId: recipient.userId,
              recipientHandle: recipient.userId,
              channelKind: 'in_app',
              fireEvent: req.fireEvent,
              title: req.title,
              body: req.body,
              urgency,
              ...(req.linkPath ? { linkPath: req.linkPath } : {}),
            });
            await this.logDispatch({
              tenantId: req.tenantId,
              proposalId: req.proposalId,
              channelKind: 'in_app',
              recipient: recipient.userId,
              fireEvent: req.fireEvent,
              status: result.status,
              ...(result.error ? { error: result.error } : {}),
            });
            if (result.status === 'sent' || result.status === 'delivered') dispatched += 1;
          } catch (err) {
            this.log('error', 'NotificationRouter in-app fallback threw', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return { dispatched, suppressed, failed };
  }

  private async logDispatch(args: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly channelKind: NotificationChannelKind;
    readonly recipient: string;
    readonly fireEvent: FireEvent;
    readonly status: DispatchResult['status'];
    readonly error?: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(args.tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${args.tenantId}'`);
      }
      await client.query(
        `INSERT INTO oweibo.notification_dispatch_log
           (tenant_id, proposal_id, channel_kind, recipient, fire_event,
            delivery_status, attempt_count, last_error, dispatched_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 1, $7,
                 CASE WHEN $6 IN ('sent','delivered') THEN NOW() ELSE NULL END)`,
        [
          args.tenantId,
          args.proposalId,
          args.channelKind,
          args.recipient,
          args.fireEvent,
          args.status,
          args.error ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.log('error', 'NotificationRouter dispatch log failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }
}

export function fireEventBucket(
  e: FireEvent,
): 'initial' | 'escalation' | 'expiry' | 'decision' {
  if (e === 'initial') return 'initial';
  if (e === 'expiry') return 'expiry';
  if (e === 'decision') return 'decision';
  return 'escalation';
}

// Re-export the PoolClient symbol for adapter modules — avoids a separate import.
export type { PoolClient };
