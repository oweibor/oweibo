/**
 * K.0 (ADR-013 §3.1/§3.3/§3.5): JobQueue — durable, priority-ordered jobs in
 * oweibo.kf_jobs.
 *
 * Claim is the OutboxRelay pattern: FOR UPDATE SKIP LOCKED over
 * (job_class ASC, created_at ASC) — priority first, FIFO within class.
 * Ordering NEVER consults wall-clock comparison across sources (INV-7);
 * run_after is a backoff gate, not an ordering key.
 *
 * Duplicate enqueue is a no-op by construction: UNIQUE
 * (tenant_id, idempotency_key) + ON CONFLICT DO NOTHING (INV-6).
 *
 * RLS note: kf_jobs is tenant-scoped (FORCE RLS). Callers supply a client
 * already carrying the right context — tenant-facing paths a tenant context,
 * the worker daemon the platform context via the sanctioned withTenantContext
 * escalation path. This class is deliberately policy-agnostic.
 */
import type { JobClass } from './contract';
import type { RetryManager } from './RetryManager';

/** Minimal pg-compatible executor (Pool, PoolClient, or a test stub). */
export interface PgExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface EnqueueInput {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly jobClass: JobClass;
  readonly idempotencyKey: string;
  readonly partitionKey?: string;
  readonly checkpoint?: unknown;
}

export interface ClaimedJob {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly jobClass: JobClass;
  readonly partitionKey: string | null;
  readonly idempotencyKey: string;
  readonly checkpoint: unknown;
  readonly attempts: number;
}

export class JobQueue {
  constructor(private readonly db: PgExecutor) {}

  /** Idempotent enqueue. Returns enqueued=false on duplicate (INV-6 no-op). */
  async enqueue(input: EnqueueInput): Promise<{ enqueued: boolean; id?: string }> {
    const r = await this.db.query(
      `INSERT INTO oweibo.kf_jobs
         (tenant_id, connector_id, job_class, partition_key, idempotency_key, checkpoint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.tenantId,
        input.connectorId,
        input.jobClass,
        input.partitionKey ?? null,
        input.idempotencyKey,
        input.checkpoint === undefined ? null : JSON.stringify(input.checkpoint),
      ],
    );
    return r.rowCount === 1 ? { enqueued: true, id: r.rows[0].id } : { enqueued: false };
  }

  /**
   * Claim up to batchSize runnable jobs (state → leased, attempts + 1).
   * Priority = job_class ASC; FIFO within class = created_at ASC.
   */
  async claim(batchSize: number): Promise<ClaimedJob[]> {
    const r = await this.db.query(
      `WITH picked AS (
         SELECT id FROM oweibo.kf_jobs
         WHERE state = 'queued' AND run_after <= NOW()
         ORDER BY job_class ASC, created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE oweibo.kf_jobs j
       SET state = 'leased', attempts = j.attempts + 1, updated_at = NOW()
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.id, j.tenant_id, j.connector_id, j.job_class, j.partition_key,
                 j.idempotency_key, j.checkpoint, j.attempts`,
      [batchSize],
    );
    return r.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      jobClass: Number(row.job_class) as JobClass,
      partitionKey: row.partition_key,
      idempotencyKey: row.idempotency_key,
      checkpoint: row.checkpoint,
      attempts: Number(row.attempts),
    }));
  }

  async complete(jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE oweibo.kf_jobs SET state = 'succeeded', updated_at = NOW() WHERE id = $1`,
      [jobId],
    );
  }

  /**
   * Record a failure: dead-letter on budget exhaustion (§3.5), otherwise
   * re-queue behind a full-jitter backoff via run_after.
   */
  async fail(job: Pick<ClaimedJob, 'id' | 'jobClass' | 'attempts'>, retry: RetryManager): Promise<'dead' | 'requeued'> {
    if (retry.shouldDeadLetter(job.jobClass, job.attempts)) {
      await this.db.query(
        `UPDATE oweibo.kf_jobs SET state = 'dead', updated_at = NOW() WHERE id = $1`,
        [job.id],
      );
      return 'dead';
    }
    const delay = retry.backoffMs(job.attempts);
    await this.db.query(
      `UPDATE oweibo.kf_jobs
       SET state = 'queued', run_after = NOW() + make_interval(secs => $2::float8 / 1000.0),
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, delay],
    );
    return 'requeued';
  }

  /** Cancellation is honored at partition boundaries (§3.5) — flag only. */
  async cancel(jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE oweibo.kf_jobs SET state = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND state IN ('queued','leased')`,
      [jobId],
    );
  }

  /** Queued depth per class — input to selectShedClass (INV-9 admission). */
  async classDepths(): Promise<Record<JobClass, number>> {
    const r = await this.db.query(
      `SELECT job_class, COUNT(*)::int AS depth
       FROM oweibo.kf_jobs WHERE state = 'queued' GROUP BY job_class`,
    );
    const depths: Record<JobClass, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of r.rows) depths[Number(row.job_class) as JobClass] = Number(row.depth);
    return depths;
  }
}
