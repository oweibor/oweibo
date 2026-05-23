/**
 * S.1: InAppChannel — always-available notification target.
 *
 * Writes a row into `oweibo.in_app_notifications`; the admin-web bell icon
 * renders unread rows for the recipient. No external dependencies; this is
 * the fallback floor when external channels (slack, email, webhook) fail.
 */
import type { Pool } from 'pg';
import type {
  DispatchResult,
  INotificationChannel,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';

export class InAppChannel implements INotificationChannel {
  readonly kind = 'in_app' as const;

  constructor(private readonly pool: Pool) {}

  async dispatch(req: NotificationDispatchRequest): Promise<DispatchResult> {
    if (!req.recipientUserId) {
      return { status: 'failed', error: 'in_app dispatch requires recipientUserId' };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(req.tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${req.tenantId}'`);
      }
      await client.query(
        `INSERT INTO oweibo.in_app_notifications
           (tenant_id, recipient_user_id, proposal_id, title, body, link_path)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
        [
          req.tenantId,
          req.recipientUserId,
          req.proposalId,
          req.title,
          req.body,
          req.linkPath ?? null,
        ],
      );
      await client.query('COMMIT');
      return { status: 'delivered', dispatchedAt: new Date().toISOString() };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      client.release();
    }
  }
}
