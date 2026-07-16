/**
 * K.0 (ADR-013 §3.1/§3.4): CheckpointManager — fencing-guarded checkpoint
 * writes. This is the repository-layer call site ADR-012 §3.1 names: the
 * transactionally-guarded write reads the lease's high-water token, applies
 * `isFencingTokenStale`, and aborts on true (INV-8).
 *
 * Defense in depth: the JS predicate gives the caller a typed rejection with
 * a reason; the SQL WHERE re-checks the token inside the UPDATE so a race
 * between read and write still cannot let a stale holder through.
 */
import { isFencingTokenStale } from './contract';
import type { PgExecutor } from './JobQueue';

export interface SaveCheckpointInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly checkpoint: unknown;
  /** The token the writing worker holds for lease scope `job:<jobId>`. */
  readonly presentedToken: bigint;
}

export type SaveCheckpointResult =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: 'stale_fencing_token' | 'no_lease' | 'job_not_leased' };

export class CheckpointManager {
  constructor(private readonly db: PgExecutor) {}

  async save(input: SaveCheckpointInput): Promise<SaveCheckpointResult> {
    // Read the high-water token (the ADR-012 §3.1 repository-layer check).
    const lease = await this.db.query(
      `SELECT fencing_token FROM oweibo.kf_leases
       WHERE tenant_id = $1 AND scope = 'job:' || $2::text`,
      [input.tenantId, input.jobId],
    );
    if (lease.rowCount !== 1) return { applied: false, reason: 'no_lease' };

    const current = BigInt(lease.rows[0].fencing_token);
    if (isFencingTokenStale(input.presentedToken, current)) {
      return { applied: false, reason: 'stale_fencing_token' };
    }

    // Guarded write: the token is re-checked in SQL so a takeover between the
    // SELECT above and this UPDATE is still caught (INV-8, race-safe).
    const r = await this.db.query(
      `UPDATE oweibo.kf_jobs j
       SET checkpoint = $3, updated_at = NOW()
       FROM oweibo.kf_leases l
       WHERE j.id = $2 AND j.tenant_id = $1 AND j.state = 'leased'
         AND l.tenant_id = j.tenant_id AND l.scope = 'job:' || j.id::text
         AND $4::bigint >= l.fencing_token
       RETURNING j.id`,
      [input.tenantId, input.jobId, JSON.stringify(input.checkpoint), input.presentedToken.toString()],
    );
    if (r.rowCount !== 1) return { applied: false, reason: 'job_not_leased' };
    return { applied: true };
  }
}
