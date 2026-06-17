/**
 * F.6 (ttv-finals): OutboxStreamConsumer — Redis Streams XREADGROUP loop
 * for the lifecycle event stream produced by OutboxRelay's dual-write
 * mode.
 *
 * Replaces SUBSCRIBE (lossy pub/sub, broadcast) with XREADGROUP (at-
 * least-once, single-claim per group). Each consumer in the
 * `consumerGroup` claims exactly one copy of each event; durability is
 * the stream's responsibility (MAXLEN ~ 100k controlled by the publisher).
 *
 * Reliability features:
 *   - Ensure-group on start (XGROUP CREATE ... MKSTREAM; ignores
 *     BUSYGROUP error).
 *   - Periodic XPENDING + XCLAIM for entries idle > 5min from any
 *     consumer (recover from a crashed sibling).
 *   - BLOCK 5000 on XREADGROUP so the consumer wakes promptly on new
 *     events but also surrenders cleanly on shutdown.
 *   - Per-event dedup via IDedupStore (PG-backed in production) so
 *     re-delivery between deploy-2 and deploy-3 of the F.6 rollout
 *     does not double-process.
 *
 * Generic over the message handler: the consumer doesn't know what
 * "tenant.created.v1" means; it just decodes the payload and calls the
 * supplied handler with the parsed JSON.
 */

import { withServiceSpan } from '@oweibo/observability';

export interface OutboxStreamMessage {
  readonly streamId: string;
  readonly eventId: string;
  readonly payload: string;
}

export interface OutboxStreamHandler {
  (message: OutboxStreamMessage): Promise<void>;
}

export interface IDedupStore {
  hasBeenProcessed(consumerGroup: string, eventId: string): Promise<boolean>;
  markProcessed(consumerGroup: string, eventId: string): Promise<void>;
  /** Periodic prune; returns rows deleted. */
  pruneOlderThan(days: number): Promise<number>;
}

/**
 * Minimal redis client surface the consumer needs. ioredis satisfies it
 * via `.call()`; node-redis@4 satisfies it via `.sendCommand`. The
 * adapter passes a thin wrapper.
 */
export interface IRedisStreamClient {
  /** Generic command dispatcher. */
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  /** Quit / disconnect — best-effort. */
  quit?(): Promise<unknown>;
}

export interface OutboxStreamConsumerOptions {
  readonly streamKey: string;
  readonly consumerGroup: string;
  readonly consumerName: string;
  readonly dedupStore: IDedupStore;
  /** Defaults to 5_000 (5s blocking read). */
  readonly blockMs?: number;
  /** Periodic prune interval (ms). Defaults to 1h. */
  readonly pruneIntervalMs?: number;
  /** Dedup retention in days; rows older than this are pruned. Defaults to 7. */
  readonly dedupRetentionDays?: number;
  /** Periodic XCLAIM interval (ms). Defaults to 60s. */
  readonly claimIntervalMs?: number;
  /** XCLAIM idle threshold (ms). Defaults to 300_000 (5min). */
  readonly claimMinIdleMs?: number;
  /** Override; defaults to console. */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

const DEFAULT_BLOCK_MS = 5_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_CLAIM_INTERVAL_MS = 60_000;
const DEFAULT_CLAIM_MIN_IDLE_MS = 5 * 60_000;
const DEFAULT_BATCH_COUNT = 32;

export class OutboxStreamConsumer {
  private readonly opts: Required<Omit<OutboxStreamConsumerOptions, 'log' | 'dedupStore'>>
    & { log: NonNullable<OutboxStreamConsumerOptions['log']>; dedupStore: IDedupStore };
  private running = false;
  private pruneTimer: NodeJS.Timeout | null = null;
  private claimTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: IRedisStreamClient,
    opts: OutboxStreamConsumerOptions,
    private readonly handler: OutboxStreamHandler,
  ) {
    this.opts = {
      streamKey: opts.streamKey,
      consumerGroup: opts.consumerGroup,
      consumerName: opts.consumerName,
      dedupStore: opts.dedupStore,
      blockMs: opts.blockMs ?? DEFAULT_BLOCK_MS,
      pruneIntervalMs: opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
      dedupRetentionDays: opts.dedupRetentionDays ?? DEFAULT_RETENTION_DAYS,
      claimIntervalMs: opts.claimIntervalMs ?? DEFAULT_CLAIM_INTERVAL_MS,
      claimMinIdleMs: opts.claimMinIdleMs ?? DEFAULT_CLAIM_MIN_IDLE_MS,
      log: opts.log ?? defaultLog,
    };
  }

  /**
   * Idempotently ensure the consumer group exists.
   *
   * Start position `0` (NOT `$`) so an at-least-once promise survives
   * the bootstrap race: when the producer starts XADDing entries
   * before the consumer group exists (F.6 deploy-1 → deploy-2 window),
   * `$` would have silently dropped every backlog entry. `0` makes
   * the consumer pick them up from the head of the stream.
   *
   * Same logic for the NOGROUP recovery path in loop(): if a stream
   * is deleted out from under us, re-creating the group at `0`
   * preserves at-least-once for any entries the replacement stream
   * received between deletion and recreation.
   *
   * Operators who specifically want only-new-messages behaviour
   * (e.g. a dev environment with a poisoned backlog) can re-CREATE
   * the group manually with `XGROUP SETID … $` once their tooling
   * is in place.
   */
  async ensureGroup(): Promise<void> {
    try {
      // MKSTREAM creates the stream if it doesn't exist (otherwise XGROUP
      // CREATE fails on a non-existent stream).
      await this.redis.call(
        'XGROUP', 'CREATE',
        this.opts.streamKey, this.opts.consumerGroup,
        '0',           // start position: deliver every entry already in the stream
        'MKSTREAM',
      );
      this.opts.log('info', 'OutboxStreamConsumer: created group', {
        stream: this.opts.streamKey, group: this.opts.consumerGroup,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('BUSYGROUP')) return; // Group already exists — fine.
      throw err;
    }
  }

  /**
   * Start consuming. Returns immediately; the loop runs in the
   * background. Call stop() to surrender.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
    this.pruneTimer = setInterval(() => void this.prune(), this.opts.pruneIntervalMs);
    this.pruneTimer.unref?.();
    this.claimTimer = setInterval(() => void this.reclaimStale(), this.opts.claimIntervalMs);
    this.claimTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; }
  }

  // ── Loop ────────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.readBatch();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NOGROUP')) {
          // Stream was deleted out from under us — re-create + retry.
          this.opts.log('warn', 'OutboxStreamConsumer: NOGROUP, re-creating', { stream: this.opts.streamKey });
          await this.ensureGroup().catch(() => undefined);
          continue;
        }
        this.opts.log('error', 'OutboxStreamConsumer.loop threw', { error: msg });
        // Brief backoff so we don't tight-loop on a persistent failure.
        await delay(1_000);
      }
    }
  }

  private async readBatch(): Promise<void> {
    // XREADGROUP GROUP <group> <consumer> COUNT N BLOCK ms STREAMS key >
    const result = await this.redis.call(
      'XREADGROUP', 'GROUP', this.opts.consumerGroup, this.opts.consumerName,
      'COUNT', DEFAULT_BATCH_COUNT,
      'BLOCK', this.opts.blockMs,
      'STREAMS', this.opts.streamKey, '>',
    ) as unknown;
    const messages = parseXReadResult(result, this.opts.streamKey);
    for (const m of messages) {
      await this.processOne(m);
    }
  }

  private async processOne(m: OutboxStreamMessage): Promise<void> {
    try {
      // F.7.1: per-event span with eventId + dedup outcome attributes.
      await withServiceSpan({
        name: 'outbox.consume',
        attributes: {
          'oweibo.event_id': m.eventId,
          'oweibo.stream': this.opts.streamKey,
          'oweibo.consumer_group': this.opts.consumerGroup,
        },
      }, async (recordAttr) => {
        const seen = await this.opts.dedupStore.hasBeenProcessed(this.opts.consumerGroup, m.eventId);
        if (seen) {
          recordAttr('oweibo.outbox.dedup_hit', true);
          await this.ack(m.streamId);
          return;
        }
        recordAttr('oweibo.outbox.dedup_hit', false);
        await this.handler(m);
        await this.opts.dedupStore.markProcessed(this.opts.consumerGroup, m.eventId);
        await this.ack(m.streamId);
      });
    } catch (err) {
      // Don't XACK — leave the message in PEL so XCLAIM can re-deliver
      // it after the idle threshold OR a sibling consumer can pick it up.
      this.opts.log('warn', 'OutboxStreamConsumer: handler threw, NOT acking', {
        eventId: m.eventId, streamId: m.streamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ack(streamId: string): Promise<void> {
    await this.redis.call('XACK', this.opts.streamKey, this.opts.consumerGroup, streamId);
  }

  // ── Periodic maintenance ────────────────────────────────────────────────

  private async prune(): Promise<void> {
    try {
      const n = await this.opts.dedupStore.pruneOlderThan(this.opts.dedupRetentionDays);
      if (n > 0) {
        this.opts.log('info', 'OutboxStreamConsumer: pruned dedup rows', { count: n });
      }
    } catch (err) {
      this.opts.log('warn', 'OutboxStreamConsumer.prune threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reclaim and process every PEL entry whose idle time exceeds
   * `claimMinIdleMs`. Advances through the entire backlog by
   * threading the cursor that XAUTOCLAIM returns (out[0]) back into
   * the next call, rather than restarting at `'0-0'` every tick. A
   * fully-drained cycle ends when XAUTOCLAIM returns the special
   * cursor `'0-0'`.
   *
   * Malformed entries (no `payload` field) are XACK'd inline instead
   * of being silently skipped — otherwise they would persist in the
   * PEL forever and be re-fetched on every cycle.
   */
  private async reclaimStale(): Promise<void> {
    let cursor = '0-0';
    let safetyBudget = 1000; // Worst-case 1000×COUNT entries per tick.
    try {
      while (this.running && safetyBudget > 0) {
        safetyBudget -= 1;
        // XAUTOCLAIM is the modern (Redis 6.2+) way; falls back to XPENDING+XCLAIM
        // would be heavier. We assume 6.2+ since the deploy target is post-2022.
        const out = await this.redis.call(
          'XAUTOCLAIM',
          this.opts.streamKey,
          this.opts.consumerGroup,
          this.opts.consumerName,
          this.opts.claimMinIdleMs,
          cursor,
          'COUNT', 32,
        ) as unknown;
        // Result shape: [next_cursor, [[id, [field, value, ...]], ...], deleted_ids[]]
        if (!Array.isArray(out) || out.length < 2) return;
        const nextCursor = String(out[0]);
        const entries = out[1];
        if (!Array.isArray(entries)) return;
        for (const entry of entries as unknown[]) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          const streamId = String(entry[0]);
          const fields = entry[1] as unknown;
          const m = entryToMessage(streamId, fields);
          if (m) {
            await this.processOne(m);
          } else {
            // Malformed entry (no `payload` field). XACK it inline so
            // it stops re-appearing in every XAUTOCLAIM cycle and
            // burning claim budget — the alternative is an
            // ever-growing PEL with the same poison entry getting
            // re-fetched every claimIntervalMs forever.
            this.opts.log('warn', 'OutboxStreamConsumer: acking malformed PEL entry', {
              streamId, stream: this.opts.streamKey,
            });
            await this.ack(streamId).catch(() => undefined);
          }
        }
        // Cursor `0-0` from XAUTOCLAIM means "no more entries to scan".
        if (nextCursor === '0-0' || entries.length === 0) return;
        cursor = nextCursor;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NOGROUP')) return; // Race with stream deletion — fine.
      this.opts.log('warn', 'OutboxStreamConsumer.reclaimStale threw', { error: msg });
    }
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

export function parseXReadResult(raw: unknown, expectedStream: string): OutboxStreamMessage[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return [];
  const messages: OutboxStreamMessage[] = [];
  // Shape: [[stream, [[id, [field, value, ...]], ...]], ...]
  for (const streamBlock of raw as unknown[]) {
    if (!Array.isArray(streamBlock) || streamBlock.length < 2) continue;
    const streamKey = String(streamBlock[0]);
    if (streamKey !== expectedStream) continue;
    const entries = streamBlock[1];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const streamId = String(entry[0]);
      const m = entryToMessage(streamId, entry[1]);
      if (m) messages.push(m);
    }
  }
  return messages;
}

function entryToMessage(streamId: string, fields: unknown): OutboxStreamMessage | null {
  if (!Array.isArray(fields)) return null;
  let payload: string | undefined;
  let eventId: string | undefined;
  for (let i = 0; i < fields.length - 1; i += 2) {
    const k = String(fields[i]);
    const v = String(fields[i + 1]);
    if (k === 'payload') payload = v;
    else if (k === 'eventId') eventId = v;
  }
  if (payload === undefined) return null;
  // Fall back to streamId as event id when the publisher didn't tag one
  // (older publishers). The deploy-2 dedup test exercises this.
  return { streamId, eventId: eventId || streamId, payload };
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === 'error') console.error(`[OutboxStreamConsumer] ${line}`);
  else if (level === 'warn') console.warn(`[OutboxStreamConsumer] ${line}`);
  else console.log(`[OutboxStreamConsumer] ${line}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}
