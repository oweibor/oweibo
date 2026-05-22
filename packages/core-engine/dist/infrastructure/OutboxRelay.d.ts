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
export declare class OutboxRelay {
    private readonly pool;
    private readonly publisher;
    private timer;
    private running;
    private readonly intervalMs;
    private readonly batchSize;
    private readonly maxAttempts;
    private readonly log;
    /** In-memory per-id attempt counter; resets on process restart (safe — rows are durable). */
    private readonly attempts;
    constructor(pool: Pool, publisher: OutboxPublisher, opts?: OutboxRelayOptions);
    start(): void;
    stop(): void;
    /**
     * Run one drain iteration. Public so tests can drive it deterministically.
     * Returns the number of rows successfully published this tick.
     */
    tick(): Promise<number>;
    private drainOnce;
}
//# sourceMappingURL=OutboxRelay.d.ts.map