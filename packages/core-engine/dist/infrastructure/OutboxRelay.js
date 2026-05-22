"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxRelay = void 0;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 100;
class OutboxRelay {
    pool;
    publisher;
    timer = null;
    running = false;
    intervalMs;
    batchSize;
    maxAttempts;
    log;
    /** In-memory per-id attempt counter; resets on process restart (safe — rows are durable). */
    attempts = new Map();
    constructor(pool, publisher, opts = {}) {
        this.pool = pool;
        this.publisher = publisher;
        this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
        this.maxAttempts = opts.maxAttemptsPerRow ?? DEFAULT_MAX_ATTEMPTS;
        this.log = opts.log ?? defaultLog;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick();
        }, this.intervalMs);
        // Don't keep the event loop alive solely because of the relay timer.
        if (typeof this.timer.unref === 'function')
            this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /**
     * Run one drain iteration. Public so tests can drive it deterministically.
     * Returns the number of rows successfully published this tick.
     */
    async tick() {
        if (this.running)
            return 0;
        this.running = true;
        try {
            return await this.drainOnce();
        }
        catch (err) {
            this.log('error', 'OutboxRelay.tick threw', { error: errMessage(err) });
            return 0;
        }
        finally {
            this.running = false;
        }
    }
    async drainOnce() {
        const client = await this.pool.connect();
        let published = 0;
        try {
            await client.query('BEGIN');
            // Platform admin scope: lifecycle events are cross-tenant by nature.
            // SECURITY DEFINER would be cleaner but the outbox table currently has
            // no RLS — this guard is forward-compatible.
            await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
            const result = await client.query(`SELECT id, subject, payload
           FROM oweibo.outbox
          WHERE published_at IS NULL
          ORDER BY ts ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED`);
            if (result.rows.length === 0) {
                await client.query('COMMIT');
                return 0;
            }
            const publishedIds = [];
            const deadLetterIds = [];
            for (const row of result.rows) {
                const channel = `oweibo.lifecycle.${row.subject}`;
                const body = JSON.stringify({ subject: row.subject, payload: row.payload });
                try {
                    await this.publisher.publish(channel, body);
                    publishedIds.push(row.id);
                    this.attempts.delete(row.id);
                }
                catch (err) {
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
                await client.query(`UPDATE oweibo.outbox
              SET published_at = NOW()
            WHERE id = ANY($1::uuid[])`, [publishedIds]);
                published = publishedIds.length;
            }
            if (deadLetterIds.length > 0) {
                await client.query(`UPDATE oweibo.outbox
              SET published_at = NOW(),
                  payload = jsonb_set(
                    COALESCE(payload, '{}'::jsonb),
                    '{_dead_letter}',
                    'true'::jsonb,
                    true
                  )
            WHERE id = ANY($1::uuid[])`, [deadLetterIds]);
            }
            await client.query('COMMIT');
            return published;
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
}
exports.OutboxRelay = OutboxRelay;
function defaultLog(level, message, extra) {
    const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
    if (level === 'error')
        console.error(`[OutboxRelay] ${line}`);
    else if (level === 'warn')
        console.warn(`[OutboxRelay] ${line}`);
    else
        console.log(`[OutboxRelay] ${line}`);
}
function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=OutboxRelay.js.map