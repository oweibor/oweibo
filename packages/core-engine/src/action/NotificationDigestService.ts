/**
 * Audit-fix (S.1): NotificationDigestService — backs the "≤ 1
 * notification per 5 min per recipient unless urgent" mitigation
 * that S.1's risk register lists but never schematized.
 *
 * Flow per non-urgent notification:
 *   1. NotificationRouter calls `enqueue(req)` instead of dispatching
 *      immediately. The row lands in oweibo.notification_digest_queue
 *      with state='pending' and enqueued_at=NOW().
 *   2. ApprovalLifecycleWorker's flush hook runs once per tick. For
 *      each (recipient, channel_kind) pair whose oldest pending row
 *      has been waiting >= digestIntervalSeconds, the worker:
 *       a. Bundles all pending rows for that pair into a single
 *          digest notification (title summarizes the count + classes).
 *       b. Dispatches via NotificationRouter (bypass digest this time —
 *          the urgency flag is set internally on the bundle).
 *       c. Marks the source rows state='flushed', flushed_at=NOW().
 *   3. Urgent notifications skip the queue entirely — the router
 *      dispatches immediately.
 *
 * Cancellation: when a proposal is decided (approve/reject) before
 * its enqueued notification flushes, the worker marks the row
 * state='cancelled' so the digest doesn't include stale entries.
 */
import type { Pool, PoolClient } from 'pg';

export type DigestChannelKind = 'slack' | 'email' | 'webhook' | 'in_app';

export interface DigestEnqueueRequest {
  readonly tenantId: string;
  readonly proposalId?: string;
  readonly recipientUserId: string;
  readonly channelKind: DigestChannelKind;
  readonly fireEvent: string;
  readonly title: string;
  readonly body?: string;
  readonly linkPath?: string;
  readonly urgency?: 'normal' | 'urgent';
}

export interface PendingDigestRow {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalId: string | null;
  readonly recipientUserId: string;
  readonly channelKind: DigestChannelKind;
  readonly fireEvent: string;
  readonly title: string;
  readonly body: string | null;
  readonly linkPath: string | null;
  readonly enqueuedAt: Date;
}

export interface DigestBundle {
  readonly tenantId: string;
  readonly recipientUserId: string;
  readonly channelKind: DigestChannelKind;
  readonly rows: readonly PendingDigestRow[];
  readonly oldestEnqueuedAt: Date;
}

export interface NotificationDigestServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
  /**
   * How long a non-urgent notification waits before flushing as part of
   * a digest. Default 300s (5 minutes, matching the S.1 risk
   * mitigation).
   */
  digestIntervalSeconds?: number;
  log?: (level: 'info' | 'warn' | 'error', line: string, ctx?: unknown) => void;
}

export class NotificationDigestService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly digestIntervalSeconds: number;
  private readonly log: NonNullable<NotificationDigestServiceOptions['log']>;

  constructor(private readonly pool: Pool, opts: NotificationDigestServiceOptions = {}) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.digestIntervalSeconds = opts.digestIntervalSeconds ?? 300;
    this.log = opts.log ?? defaultLog;
  }

  /**
   * Enqueue a notification. Urgent notifications return false (caller
   * should dispatch immediately). Non-urgent return true; the dispatch
   * happens on the next flush.
   */
  async enqueue(req: DigestEnqueueRequest): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if ((req.urgency ?? 'normal') === 'urgent') return false;

    await this.tx(req.tenantId, async (client) => {
      await client.query(
        `INSERT INTO oweibo.notification_digest_queue
           (tenant_id, proposal_id, recipient_user_id, channel_kind,
            fire_event, title, body, link_path, urgency)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'normal')`,
        [
          req.tenantId,
          req.proposalId ?? null,
          req.recipientUserId,
          req.channelKind,
          req.fireEvent,
          req.title,
          req.body ?? null,
          req.linkPath ?? null,
        ],
      );
    });
    return true;
  }

  /**
   * Worker hook: pull all (recipient, channel) groups whose oldest
   * pending row is older than digestIntervalSeconds and atomically
   * mark them flushed. Returns the bundles for the worker to dispatch
   * via NotificationRouter — the service does NOT dispatch directly so
   * the worker's existing channel-routing logic stays the single
   * dispatch entry point.
   */
  async claimDueBundles(limit = 100): Promise<readonly DigestBundle[]> {
    if (!this.isEnabled()) return [];
    const cutoff = new Date(this.now().getTime() - this.digestIntervalSeconds * 1000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);

      // Find candidate (recipient, channel) groups whose oldest row is due.
      // Two-step query: first identify the groups, then claim every
      // pending row in each group atomically.
      const groups = await client.query<{
        tenant_id: string;
        recipient_user_id: string;
        channel_kind: DigestChannelKind;
        oldest_enqueued_at: Date;
      }>(
        `SELECT tenant_id, recipient_user_id, channel_kind,
                MIN(enqueued_at) AS oldest_enqueued_at
           FROM oweibo.notification_digest_queue
          WHERE state = 'pending' AND enqueued_at <= $1
          GROUP BY tenant_id, recipient_user_id, channel_kind
          ORDER BY MIN(enqueued_at) ASC
          LIMIT $2`,
        [cutoff, limit],
      );

      const bundles: DigestBundle[] = [];
      for (const g of groups.rows) {
        const claimed = await client.query<{
          id: string;
          tenant_id: string;
          proposal_id: string | null;
          recipient_user_id: string;
          channel_kind: DigestChannelKind;
          fire_event: string;
          title: string;
          body: string | null;
          link_path: string | null;
          enqueued_at: Date;
        }>(
          `UPDATE oweibo.notification_digest_queue
              SET state = 'flushed', flushed_at = NOW()
            WHERE tenant_id = $1::uuid
              AND recipient_user_id = $2::uuid
              AND channel_kind = $3
              AND state = 'pending'
            RETURNING id, tenant_id, proposal_id, recipient_user_id,
                      channel_kind, fire_event, title, body, link_path,
                      enqueued_at`,
          [g.tenant_id, g.recipient_user_id, g.channel_kind],
        );
        if (claimed.rows.length === 0) continue;
        bundles.push({
          tenantId: g.tenant_id,
          recipientUserId: g.recipient_user_id,
          channelKind: g.channel_kind,
          rows: claimed.rows.map((r) => ({
            id: r.id,
            tenantId: r.tenant_id,
            proposalId: r.proposal_id,
            recipientUserId: r.recipient_user_id,
            channelKind: r.channel_kind,
            fireEvent: r.fire_event,
            title: r.title,
            body: r.body,
            linkPath: r.link_path,
            enqueuedAt: r.enqueued_at,
          })),
          oldestEnqueuedAt: g.oldest_enqueued_at,
        });
      }

      await client.query('COMMIT');
      return bundles;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.log('warn', 'claimDueBundles failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Cancel pending queue rows for a proposal that just got decided
   * (approved/rejected) — the original notification is stale.
   */
  async cancelForProposal(tenantId: string, proposalId: string): Promise<number> {
    if (!this.isEnabled()) return 0;
    return this.tx(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE oweibo.notification_digest_queue
            SET state = 'cancelled', flushed_at = NOW()
          WHERE proposal_id = $1::uuid AND state = 'pending'`,
        [proposalId],
      );
      return r.rowCount ?? 0;
    });
  }

  // ── Pure helper for composing a bundled-notification title/body ────────

  /**
   * Compose a single human-readable title/body from a bundle. The
   * caller (worker) uses this to drive NotificationRouter with one
   * dispatch call per (recipient, channel) instead of N.
   */
  composeBundledMessage(bundle: DigestBundle): { title: string; body: string } {
    const count = bundle.rows.length;
    if (count === 1) {
      const r = bundle.rows[0]!;
      return { title: r.title, body: r.body ?? '' };
    }
    const title = `${count} approval notifications pending (digest)`;
    const body = bundle.rows
      .map((r) => `• ${r.fireEvent}: ${r.title}`)
      .join('\n');
    return { title, body };
  }

  // ── Internals ──────────────────────────────────────────────────────────

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

function defaultEnabled(): boolean {
  return process.env.NOTIFICATION_DIGEST_ENABLED === 'true';
}

function defaultLog(level: 'info' | 'warn' | 'error', line: string, _ctx?: unknown): void {
  if (level === 'error') console.error(`[NotificationDigest] ${line}`);
  else if (level === 'warn') console.warn(`[NotificationDigest] ${line}`);
  else console.log(`[NotificationDigest] ${line}`);
}
