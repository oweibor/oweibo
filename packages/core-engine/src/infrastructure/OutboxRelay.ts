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
import { withServiceSpan } from '@oweibo/observability';

export interface OutboxPublisher {
  /** Publish a JSON-encoded payload to a Redis channel (pub/sub). */
  publish(channel: string, payload: string): Promise<void>;
  /**
   * F.6: XADD to a Redis Stream. Optional — implementations without
   * stream support either omit this or throw. OutboxRelay only calls
   * this method when `streamsDualWriteEnabled` or `streamsOnlyEnabled`
   * is true.
   */
  addToStream?(
    stream: string,
    payload: string,
    opts?: { eventId?: string; maxLen?: number },
  ): Promise<void>;
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
  /**
   * F.6 deploy-1 flag: when true, every successful publish ALSO XADDs
   * to `oweibo.lifecycle.<subject>` (in addition to pub/sub PUBLISH).
   * Default false. Pairs with the consumer-side `OUTBOX_STREAMS_ENABLED`
   * flag for the 3-deploy rollout.
   */
  streamsDualWriteEnabled?: boolean;
  /**
   * F.6 deploy-3 flag: when true AND `streamsDualWriteEnabled` is
   * false, skip the pub/sub PUBLISH entirely; XADD only. Reaching this
   * state cleanly requires deploy-2 (consumers reading streams) to be
   * green first. Default false.
   */
  streamsOnlyEnabled?: boolean;
  /** F.6: MAXLEN ~ N on every XADD so the stream auto-trims. Default 100_000. */
  streamMaxLen?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 100;
const DEFAULT_STREAM_MAXLEN = 100_000;

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
  private readonly streamsDualWriteEnabled: boolean;
  private readonly streamsOnlyEnabled: boolean;
  private readonly streamMaxLen: number;
  /** In-memory per-id attempt counter; resets on process restart (safe — rows are durable). */
  private readonly attempts = new Map<string, number>();
  /**
   * F.6 fix: per-row per-transport success tracking. Without it, a
   * dual-write where PUBLISH succeeds but XADD fails would re-PUBLISH
   * on the next tick — legacy SUBSCRIBE consumers (no dedup ledger)
   * would then process the event twice. We remember which transport
   * already succeeded so the retry only re-runs the missing one.
   * Cleared on full success (both transports) or dead-letter. Resets
   * on process restart (acceptable — at worst causes one extra
   * publish per in-flight row, which the consumer dedups via
   * processed_outbox_events).
   */
  private readonly transportSuccess = new Map<string, { pubsub: boolean; stream: boolean }>();

  constructor(
    private readonly pool: Pool,
    private readonly publisher: OutboxPublisher,
    opts: OutboxRelayOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = opts.maxAttemptsPerRow ?? DEFAULT_MAX_ATTEMPTS;
    this.log = opts.log ?? defaultLog;
    this.streamsDualWriteEnabled = opts.streamsDualWriteEnabled ?? false;
    this.streamsOnlyEnabled = opts.streamsOnlyEnabled ?? false;
    this.streamMaxLen = opts.streamMaxLen ?? DEFAULT_STREAM_MAXLEN;

    // Fail-loud: streams flags require the optional addToStream method.
    if ((this.streamsDualWriteEnabled || this.streamsOnlyEnabled) && !publisher.addToStream) {
      throw new Error(
        'OutboxRelay: streamsDualWriteEnabled / streamsOnlyEnabled set but publisher has no addToStream() method',
      );
    }
  }

  /** Compute the effective per-row writes given current flags. */
  private writeMode(): 'pubsub' | 'dual' | 'streams_only' {
    if (this.streamsOnlyEnabled && !this.streamsDualWriteEnabled) return 'streams_only';
    if (this.streamsDualWriteEnabled) return 'dual';
    return 'pubsub';
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
      // F.7.1: every periodic worker tick emits a span with batch size + counts.
      return await withServiceSpan(
        { name: 'outbox.tick', attributes: { 'oweibo.write_mode': this.writeMode() } },
        async (recordAttr) => {
          const published = await this.drainOnce();
          recordAttr('oweibo.outbox.published', published);
          return published;
        },
      );
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

      const mode = this.writeMode();

      for (const row of result.rows as OutboxRow[]) {
        const channel = `oweibo.lifecycle.${row.subject}`;
        // F.6: include row.id as eventId so consumers can dedup via
        // processed_outbox_events on it (XADD * generates its own
        // stream-internal id; we tag the row id inside the payload so
        // the consumer keys dedup on the source-of-truth id).
        const body = JSON.stringify({ eventId: row.id, subject: row.subject, payload: row.payload });

        // Compute what each transport needs, accounting for any
        // already-succeeded transport from a previous tick.
        const prior = this.transportSuccess.get(row.id) ?? { pubsub: false, stream: false };
        const needsPubSub = (mode === 'pubsub' || mode === 'dual') && !prior.pubsub;
        const needsStream = (mode === 'dual' || mode === 'streams_only') && !prior.stream;

        let transportError: unknown = null;
        try {
          if (needsPubSub) {
            await this.publisher.publish(channel, body);
            prior.pubsub = true;
            this.transportSuccess.set(row.id, prior);
          }
        } catch (err) {
          transportError = err;
        }
        try {
          if (needsStream && transportError === null) {
            await this.publisher.addToStream!(channel, body, {
              eventId: row.id,
              maxLen: this.streamMaxLen,
            });
            prior.stream = true;
            this.transportSuccess.set(row.id, prior);
          }
        } catch (err) {
          transportError = err;
        }

        // Compute final completion state for this row.
        const required = {
          pubsub: (mode === 'pubsub' || mode === 'dual'),
          stream: (mode === 'dual' || mode === 'streams_only'),
        };
        const done =
          (!required.pubsub || prior.pubsub) &&
          (!required.stream || prior.stream);

        if (done) {
          publishedIds.push(row.id);
          this.attempts.delete(row.id);
          this.transportSuccess.delete(row.id);
        } else if (transportError !== null) {
          const next = (this.attempts.get(row.id) ?? 0) + 1;
          this.attempts.set(row.id, next);
          this.log('warn', 'OutboxRelay publish failed', {
            id: row.id, subject: row.subject, attempts: next, mode,
            pubsubOk: prior.pubsub, streamOk: prior.stream,
            error: errMessage(transportError),
          });
          if (next >= this.maxAttempts) {
            deadLetterIds.push(row.id);
            this.attempts.delete(row.id);
            this.transportSuccess.delete(row.id);
            this.log('error', 'OutboxRelay dead-lettering row after max attempts', {
              id: row.id, subject: row.subject, attempts: next, mode,
              pubsubOk: prior.pubsub, streamOk: prior.stream,
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
