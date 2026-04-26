/**
 * DocGeneratorWorker — long-polling worker that consumes DocGeneratorQueue (C1, C2, v10.5).
 *
 * Concurrency limits (C2):
 *   - maxConcurrentPerPod:    max parallel jobs on this process (default 3)
 *   - maxConcurrentPerTenant: max parallel jobs for one tenant across pods (default 2)
 *     Enforced via Redis sorted-set `doc-running:{tenantId}`.
 *
 * Heartbeat (C4): SETEX doc-heartbeat:{sessionId} 30 'alive' every 10 s.
 *
 * Token accounting (C14 / CRIT-1): adds ACTUAL spend (adapter.totalSpent) to quota
 * counter via redis.incrby after each run.
 *
 * Re-queue behaviour (CRIT-2): when per-tenant concurrency is full the original job
 * (with its sessionId intact) is re-enqueued with a 30 s back-off, up to MAX_TENANT_RETRIES
 * attempts before the session is marked failed.
 */

import type { DocGeneratorPipeline, PipelineResult } from '../DocGeneratorPipeline.js';
import type { DocGeneratorQueue } from './DocGeneratorQueue.js';
import type { ILogger } from '../analysis/validateGlobPatterns.js';
import type { DocGenJob } from '../DocGeneratorPipeline.js';

const DEFAULT_MAX_PER_POD    = 3;
const DEFAULT_MAX_PER_TENANT = 2;
const HEARTBEAT_INTERVAL_MS  = 10_000;
const POLL_TIMEOUT_SEC       = 5;
const TENANT_RETRY_DELAY_MS  = 30_000;
const MAX_TENANT_RETRIES     = 3;

type RedisClient = {
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  zcard(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
};

export interface WorkerConfig {
  readonly maxConcurrentPerPod?:    number;
  readonly maxConcurrentPerTenant?: number;
}

export class DocGeneratorWorker {
  private running   = 0;
  private stopped   = false;
  private readonly maxPerPod:    number;
  private readonly maxPerTenant: number;

  constructor(
    private readonly pipeline: DocGeneratorPipeline,
    private readonly queue:    DocGeneratorQueue,
    private readonly redis:    RedisClient,
    private readonly logger:   ILogger,
    config:                    WorkerConfig = {},
  ) {
    this.maxPerPod    = config.maxConcurrentPerPod    ?? DEFAULT_MAX_PER_POD;
    this.maxPerTenant = config.maxConcurrentPerTenant ?? DEFAULT_MAX_PER_TENANT;
  }

  /** Start the polling loop. Returns when stop() is called. */
  async start(): Promise<void> {
    this.logger.info('[DocGeneratorWorker] Starting worker loop');
    while (!this.stopped) {
      if (this.running >= this.maxPerPod) {
        await delay(500);
        continue;
      }

      const job = await this.queue.dequeue(POLL_TIMEOUT_SEC);
      if (!job) continue;

      const tenantSlots = await this.redis.zcard(`doc-running:${job.tenantId}`);
      if (tenantSlots >= this.maxPerTenant) {
        const retryCount = (job as DocGenJob & { _tenantRetries?: number })._tenantRetries ?? 0;
        if (retryCount >= MAX_TENANT_RETRIES) {
          // Give up — fail the session rather than loop indefinitely
          this.logger.warn(`[DocGeneratorWorker] Tenant ${job.tenantId} concurrency limit exceeded after ${MAX_TENANT_RETRIES} retries — failing session ${job.sessionId}`);
          await this.queue.updateStatus(job.tenantId, job.sessionId, {
            status:        'failed',
            failedAt:      new Date().toISOString(),
            failureReason: 'tenant-concurrency-limit-exceeded',
          });
        } else {
          // Re-enqueue with the ORIGINAL sessionId preserved (CRIT-2) and incremented retry count
          this.logger.info(`[DocGeneratorWorker] Tenant ${job.tenantId} at concurrency limit — re-queuing session ${job.sessionId} (attempt ${retryCount + 1}/${MAX_TENANT_RETRIES})`);
          await delay(TENANT_RETRY_DELAY_MS);
          await this.queue.enqueue({
            ...(job as DocGenJob & { _tenantRetries?: number }),
            sessionId:     job.sessionId,   // preserve original ID
            _tenantRetries: retryCount + 1,
          });
        }
        continue;
      }

      this.running++;
      void this.processJob(job).finally(() => { this.running--; });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async processJob(job: DocGenJob): Promise<void> {
    const { tenantId, sessionId } = job;
    const runKey = `doc-running:${tenantId}`;

    await this.redis.zadd(runKey, Date.now(), sessionId);
    await this.redis.expire(runKey, 3600);
    await this.queue.updateStatus(tenantId, sessionId, { status: 'running', startedAt: new Date().toISOString() });

    const ctrl    = new AbortController();
    const hbTimer = setInterval(() => {
      void this.queue.heartbeat(sessionId);
    }, HEARTBEAT_INTERVAL_MS);

    let result: PipelineResult | undefined;
    try {
      result = await this.pipeline.run(job, ctrl.signal);

      // Record actual token spend — pipeline exposes totalSpent via the budget adapter (CRIT-1 / C14)
      const tokensSpent = result.tokensSpent ?? 0;
      if (tokensSpent > 0) {
        await this.queue.addTokenSpend(tenantId, tokensSpent);
      }

      await this.queue.updateStatus(tenantId, sessionId, {
        status:       'complete',
        completedAt:  new Date().toISOString(),
        writtenFiles: result.writtenFiles,
        warningCount: result.warnings.length,
      });
      this.logger.info(`[DocGeneratorWorker] Session ${sessionId} complete — ${result.writtenFiles.length} files written, ${tokensSpent} tokens spent`);
    } catch (err) {
      const isCancelled = (err as Error).name === 'AbortError';
      await this.queue.updateStatus(tenantId, sessionId, {
        status:        isCancelled ? 'cancelled' : 'failed',
        failedAt:      new Date().toISOString(),
        failureReason: (err as Error).message,
      });
      if (!isCancelled) {
        this.logger.error(`[DocGeneratorWorker] Session ${sessionId} failed: ${(err as Error).message}`);
      }
    } finally {
      clearInterval(hbTimer);
      await this.redis.zrem(runKey, sessionId);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
