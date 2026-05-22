/**
 * T.0: OutboxRelay — drains oweibo.outbox to Redis lifecycle channels.
 *
 * Polls `WHERE published_at IS NULL ORDER BY ts ASC LIMIT N` every tick, locks
 * each batch with `SELECT … FOR UPDATE SKIP LOCKED` (so multiple replicas
 * cooperate), publishes JSON to `oweibo.lifecycle.<subject>`, then sets
 * `published_at = NOW()`.
 *
 * Fail-open semantics:
 *   - Per-row publish errors do NOT throw; the row stays unpublished and is
 *     retried next tick. Logs but never blocks the loop.
 *   - After MAX_ATTEMPTS_PER_ROW failures on a single row, the row is dead-
 *     lettered: published_at = NOW() with no Redis publish, plus a console
 *     warning. Operators inspect via admin UI in a later phase.
 *
 * Backwards compatibility:
 *   - Existing outbox rows with `published_at` already set are skipped by the
 *     partial index — no work is done on them.
 *   - When Redis is unavailable, every publish fails-open; eventually rows
 *     dead-letter rather than queue indefinitely. The fail-open behaviour
 *     matches the established OperationalModeService pattern.
 */
import type { Pool } from 'pg';

export interface OutboxPublisher {
  /** Publish a JSON-encoded payload to a Redis channel. */
  publish(channel: string, payload: string): Promise<void>;
}

export interface OutboxRelayOptions {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** Max rows drained per tick. Default 100. */
  batchSize?: number;
  /** Max dead-letter attempts per row. Default 100. */
  maxAttemptsPerRow?: number;
  /** Override for tests; otherwise uses console. */
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 100;

interface OutboxRow {
  id: string;
  subject: string;
  payload: unknown;
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly log: NonNullable<OutboxRelayOptions['log']>;
  /** In-memory per-id attempt counter; resets on process restart (safe — rows are durable). */
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly publisher: OutboxPublisher,
    opts: OutboxRelayOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = opts.maxAttemptsPerRow ?? DEFAULT_MAX_ATTEMPTS;
    this.log = opts.log ?? defaultLog;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the event loop alive solely because of the relay timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one drain iteration. Public so tests can drive it deterministically.
   * Returns the number of rows successfully published this tick.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.drainOnce();
    } catch (err) {
      this.log('error', 'OutboxRelay.tick threw', { error: errMessage(err) });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async drainOnce(): Promise<number> {
    const client = await this.pool.connect();
    let published = 0;
    try {
      await client.query('BEGIN');
      // Platform admin scope: lifecycle events are cross-tenant by nature.
      // SECURITY DEFINER would be cleaner but the outbox table currently has
      // no RLS — this guard is forward-compatible.
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);

      const result = await client.query<{ id: string; subject: string; payload: unknown }>(
        `SELECT id, subject, payload
           FROM oweibo.outbox
          WHERE published_at IS NULL
          ORDER BY ts ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED`,
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const publishedIds: string[] = [];
      const deadLetterIds: string[] = [];

      for (const row of result.rows as OutboxRow[]) {
        const channel = `oweibo.lifecycle.${row.subject}`;
        const body = JSON.stringify({ subject: row.subject, payload: row.payload });
        try {
          await this.publisher.publish(channel, body);
          publishedIds.push(row.id);
          this.attempts.delete(row.id);
        } catch (err) {
          const next = (this.attempts.get(row.id) ?? 0) + 1;
          this.attempts.set(row.id, next);
          this.log('warn', 'OutboxRelay publish failed', {
            id: row.id, subject: row.subject, attempts: next, error: errMessage(err),
          });
          if (next >= this.maxAttempts) {
            deadLetterIds.push(row.id);
            this.attempts.delete(row.id);
            this.log('error', 'OutboxRelay dead-lettering row after max attempts', {
              id: row.id, subject: row.subject, attempts: next,
            });
          }
        }
      }

      if (publishedIds.length > 0) {
        await client.query(
          `UPDATE oweibo.outbox
              SET published_at = NOW()
            WHERE id = ANY($1::uuid[])`,
          [publishedIds],
        );
        published = publishedIds.length;
      }
      if (deadLetterIds.length > 0) {
        await client.query(
          `UPDATE oweibo.outbox
              SET published_at = NOW(),
                  payload = jsonb_set(
                    COALESCE(payload, '{}'::jsonb),
                    '{_dead_letter}',
                    'true'::jsonb,
                    true
                  )
            WHERE id = ANY($1::uuid[])`,
          [deadLetterIds],
        );
      }
      await client.query('COMMIT');
      return published;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === 'error') console.error(`[OutboxRelay] ${line}`);
  else if (level === 'warn') console.warn(`[OutboxRelay] ${line}`);
  else console.log(`[OutboxRelay] ${line}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
