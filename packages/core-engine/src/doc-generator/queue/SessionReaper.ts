/**
 * SessionReaper — periodic job that recovers orphaned sessions (C4, v10.5).
 *
 * On each tick (default every 60 s):
 *   1. Scans doc-running:{tenantId} sorted sets for sessions with status:'running'.
 *   2. For each, checks whether doc-heartbeat:{sessionId} exists.
 *   3. If heartbeat absent: transitions session to status:'failed', reason:'worker-lost'.
 *   4. Emits doc-generation-warning WORKER_LOST on the event bus.
 */

import type { DocGeneratorQueue } from './DocGeneratorQueue.js';
import type { TaskEventBus } from '../../ingestion/TaskEventBus.js';
import type { ILogger } from '../analysis/validateGlobPatterns.js';

const REAPER_INTERVAL_MS = 60_000;

type RedisClient = {
  /** Non-blocking cursor scan (MED-4). cursor='0' starts a new scan; done when returned cursor='0'. */
  scan(cursor: string, matchOption: 'MATCH', pattern: string, countOption: 'COUNT', count: number): Promise<[string, string[]]>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
};

export class SessionReaper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queue:    DocGeneratorQueue,
    private readonly eventBus: TaskEventBus,
    private readonly redis:    RedisClient,
    private readonly logger:   ILogger,
    private readonly intervalMs: number = REAPER_INTERVAL_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.logger.info('[SessionReaper] Started — scanning every ' + this.intervalMs + 'ms');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    try {
      // Non-blocking cursor scan replaces O(N) KEYS command (MED-4).
      const runKeys = await scanAll(this.redis, 'doc-running:*');
      for (const runKey of runKeys) {
        const tenantId  = runKey.replace('doc-running:', '');
        const sessionIds = await this.redis.zrange(runKey, 0, -1);

        for (const sessionId of sessionIds) {
          const alive = await this.queue.isAlive(sessionId);
          if (alive) continue;

          const status = await this.queue.getStatus(tenantId, sessionId);
          if (!status || status['status'] !== 'running') continue;

          this.logger.warn(`[SessionReaper] Orphaned session detected: ${sessionId} (tenant: ${tenantId})`);

          await this.queue.updateStatus(tenantId, sessionId, {
            status:        'failed',
            failedAt:      new Date().toISOString(),
            failureReason: 'worker-lost',
          });

          await this.eventBus.publish(sessionId, {
            taskId:  sessionId,
            type:    'doc-generation-warning',
            message: `Session ${sessionId} orphaned — worker heartbeat lost`,
            payload: { code: 'WORKER_LOST', tenantId, sessionId },
          });
        }
      }
    } catch (err) {
      this.logger.error(`[SessionReaper] tick error: ${(err as Error).message}`);
    }
  }
}

/** Fully iterate a SCAN cursor, returning all matching keys. Each round-trip scans ~100 keys. */
async function scanAll(redis: RedisClient, pattern: string): Promise<string[]> {
  const result: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    result.push(...keys);
    cursor = nextCursor;
  } while (cursor !== '0');
  return result;
}
