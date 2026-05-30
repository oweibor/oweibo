/**
 * F.6 (ttv-finals): Postgres-backed IDedupStore for OutboxStreamConsumer.
 *
 * Backs the (consumer_group, event_id) primary-key table installed by
 * migration 20260612_000054_outbox_streams.sql. The consumer queries
 * it once per delivered event and writes one row on success. Stale
 * rows are pruned by the consumer's periodic timer.
 */
import type { Pool } from 'pg';
import type { IDedupStore } from './OutboxStreamConsumer.js';

export class PgProcessedOutboxDedupStore implements IDedupStore {
  constructor(private readonly pool: Pool) {}

  async hasBeenProcessed(consumerGroup: string, eventId: string): Promise<boolean> {
    const r = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM oweibo.processed_outbox_events
          WHERE consumer_group = $1 AND event_id = $2
       ) AS exists`,
      [consumerGroup, eventId],
    );
    return r.rows[0]?.exists === true;
  }

  async markProcessed(consumerGroup: string, eventId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO oweibo.processed_outbox_events (consumer_group, event_id)
        VALUES ($1, $2)
        ON CONFLICT (consumer_group, event_id) DO NOTHING`,
      [consumerGroup, eventId],
    );
  }

  async pruneOlderThan(days: number): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM oweibo.processed_outbox_events
        WHERE processed_at < NOW() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return r.rowCount ?? 0;
  }
}
