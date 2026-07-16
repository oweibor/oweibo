/**
 * K.0 (ADR-013 §3.1/§3.2): WorkerLease — expiring leases with MONOTONIC
 * fencing tokens in oweibo.kf_leases.
 *
 * The lease row persists across holders (UNIQUE (tenant_id, scope));
 * fencing_token increments on every (re)acquire, so a holder that lost its
 * lease always carries a strictly lower token than the current one — the
 * write-side guard (CheckpointManager / repositories) rejects it (INV-8).
 *
 * NOT runWithAdvisoryLock: advisory locks give exclusion without fencing and
 * are reserved for idempotent skip-safe ticks (ADR-013 §1, Appendix A #1).
 *
 * Re-queue is transactional with lease expiry in Postgres (§3.2): the sweeper
 * statement joins jobs to their lapsed leases, so a job is never both
 * "leased by a dead worker" and "queued".
 */
import type { PgExecutor } from './JobQueue';

export interface AcquireInput {
  readonly tenantId: string;
  /** `job:<id>` for per-job leases; `connector:<id>:<op>` for exclusive operations. */
  readonly scope: string;
  readonly holder: string;
  readonly ttlSeconds: number;
}

export interface Lease {
  readonly scope: string;
  readonly holder: string;
  readonly fencingToken: bigint;
}

export class WorkerLease {
  constructor(private readonly db: PgExecutor) {}

  /**
   * Acquire the lease for `scope`, or take over a lapsed one (token bumps).
   * Returns null when the lease is validly held by someone else.
   */
  async acquire(input: AcquireInput): Promise<Lease | null> {
    const r = await this.db.query(
      `INSERT INTO oweibo.kf_leases (tenant_id, scope, holder, expires_at, heartbeat_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), NOW())
       ON CONFLICT (tenant_id, scope) DO UPDATE
         SET holder = EXCLUDED.holder,
             fencing_token = oweibo.kf_leases.fencing_token + 1,
             heartbeat_at = NOW(),
             expires_at = NOW() + make_interval(secs => $4)
         WHERE oweibo.kf_leases.expires_at < NOW()
       RETURNING fencing_token`,
      [input.tenantId, input.scope, input.holder, input.ttlSeconds],
    );
    if (r.rowCount !== 1) return null;
    return {
      scope: input.scope,
      holder: input.holder,
      fencingToken: BigInt(r.rows[0].fencing_token),
    };
  }

  /** Renew; false means the lease lapsed or was taken — stop working. */
  async heartbeat(input: AcquireInput): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE oweibo.kf_leases
       SET heartbeat_at = NOW(), expires_at = NOW() + make_interval(secs => $4)
       WHERE tenant_id = $1 AND scope = $2 AND holder = $3 AND expires_at > NOW()`,
      [input.tenantId, input.scope, input.holder, input.ttlSeconds],
    );
    return r.rowCount === 1;
  }

  /** Voluntary release: expire immediately (row persists for monotonicity). */
  async release(tenantId: string, scope: string, holder: string): Promise<void> {
    await this.db.query(
      `UPDATE oweibo.kf_leases SET expires_at = NOW()
       WHERE tenant_id = $1 AND scope = $2 AND holder = $3`,
      [tenantId, scope, holder],
    );
  }

  /**
   * Sweeper (§3.2): re-queue leased jobs whose `job:<id>` lease has lapsed.
   * Resume is from checkpoint by construction — the checkpoint column is
   * untouched. Returns the re-queued job ids.
   */
  async sweepExpiredJobLeases(): Promise<string[]> {
    const r = await this.db.query(
      `UPDATE oweibo.kf_jobs j
       SET state = 'queued', updated_at = NOW()
       FROM oweibo.kf_leases l
       WHERE l.tenant_id = j.tenant_id
         AND l.scope = 'job:' || j.id::text
         AND l.expires_at < NOW()
         AND j.state = 'leased'
       RETURNING j.id`,
    );
    return r.rows.map((row) => row.id);
  }
}
