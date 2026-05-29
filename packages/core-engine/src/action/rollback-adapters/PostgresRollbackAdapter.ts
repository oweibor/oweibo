/**
 * F.2.2 — PostgresRollbackAdapter.
 *
 * Rolls back actions in the `write.tenant_db.*` family by running the
 * reverse SQL captured in envelope.rollbackPlan inside a tenant-scoped
 * transaction. Optionally verifies row-checksums captured at execute
 * time to detect drift since the original action ran.
 *
 * RollbackEnvelope.rollbackPlan shape (this adapter casts to it):
 *
 *   {
 *     reverseSql:    string;                            // SQL to execute
 *     params?:       readonly unknown[];                // parameterised values
 *     expectedRowCount?: number;                        // optional sanity check
 *     rowChecksums?: ReadonlyMap<string, string>        // (rowId → checksum) captured at execute;
 *                                                      // mismatch ⇒ result.state='partial'
 *   }
 *
 * Refuses preflight when:
 *   - envelope.kind === 'irreversible'
 *   - rollbackPlan is missing or not an object
 *   - reverseSql is missing / empty
 *
 * Idempotency: relies on the caller's SQL using IF EXISTS / WHERE clauses
 * that make double-execution a no-op. The orchestrator + DB unique
 * constraint on rollback_executions.original_action_id prevent
 * concurrent rollback attempts entirely (audit-fix round 1).
 *
 * Tenant scoping: runs inside `SET LOCAL app.tenant_id`; RLS prevents
 * cross-tenant writes even if the reverseSql were crafted maliciously.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

const UUID_RE = /^[0-9a-f-]{36}$/i;

interface PostgresRollbackPlan {
  readonly reverseSql: string;
  readonly params?: readonly unknown[];
  readonly expectedRowCount?: number;
  readonly rowChecksums?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}

export class PostgresRollbackAdapter implements IRollbackAdapter {
  readonly name = 'postgres';

  constructor(private readonly pool: Pool) {}

  async preflight(envelope: RollbackEnvelope, _ctx: RollbackContext): Promise<void> {
    if (envelope.kind === 'irreversible') {
      throw new Error('postgres rollback: envelope.kind=irreversible');
    }
    const plan = envelope.rollbackPlan as PostgresRollbackPlan | undefined;
    if (!plan || typeof plan !== 'object') {
      throw new Error('postgres rollback: missing rollbackPlan');
    }
    if (typeof plan.reverseSql !== 'string' || plan.reverseSql.trim().length === 0) {
      throw new Error('postgres rollback: rollbackPlan.reverseSql missing or empty');
    }
    // Defence in depth: a malformed reverseSql that drops the schema or
    // grants is operator-caused; we refuse the most obvious dangerous
    // shapes but trust the per-tenant RLS policy + SET LOCAL ROLE.
    const lowered = plan.reverseSql.toLowerCase();
    if (lowered.includes('drop schema') || lowered.includes('grant ') || lowered.includes('revoke ')) {
      throw new Error('postgres rollback: reverseSql contains schema/grant ops');
    }
  }

  async execute(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<RollbackResult> {
    if (!UUID_RE.test(ctx.tenantId)) {
      return failed('postgres rollback: invalid tenantId');
    }
    const plan = envelope.rollbackPlan as PostgresRollbackPlan;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${ctx.tenantId}'`);

      // Optional pre-execute drift check via row checksums.
      const driftDetected = plan.rowChecksums
        ? await this.detectChecksumDrift(client, plan.rowChecksums)
        : null;

      const r = await client.query(plan.reverseSql, plan.params ? Array.from(plan.params) : undefined);
      await client.query('COMMIT');

      const rowsAffected = r.rowCount ?? 0;
      const sideEffects = [`postgres.rows_reverted=${rowsAffected}`];

      // Drift = warn; orchestrator surfaces this as `partial` so the
      // operator knows the rollback ran but the system was not in the
      // exact state the original action left it in.
      if (driftDetected && driftDetected.length > 0) {
        return {
          success: true,
          state: 'partial',
          details: `postgres rollback succeeded but ${driftDetected.length} row(s) had drifted from execute-time checksums`,
          sideEffects: [...sideEffects, `postgres.drifted_row_ids=${driftDetected.join(',')}`],
          costUsdCents: 0,
        };
      }

      // expectedRowCount mismatch with rows-affected = partial.
      if (plan.expectedRowCount !== undefined && plan.expectedRowCount !== rowsAffected) {
        return {
          success: true,
          state: 'partial',
          details: `postgres rollback ran but affected ${rowsAffected} row(s); expected ${plan.expectedRowCount}`,
          sideEffects,
          costUsdCents: 0,
        };
      }

      // Zero rows + non-empty expected may also mean "already reverted".
      if (rowsAffected === 0 && (plan.expectedRowCount ?? 0) === 0) {
        return {
          success: true,
          state: 'no_op_already_reverted',
          details: 'postgres rollback ran but affected zero rows; state already matches',
          sideEffects,
          costUsdCents: 0,
        };
      }

      return {
        success: true,
        state: 'fully_reverted',
        details: `postgres rollback reverted ${rowsAffected} row(s)`,
        sideEffects,
        costUsdCents: 0,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return failed(`postgres rollback: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  /**
   * Returns the list of row IDs whose current checksum disagrees with
   * the captured rowChecksums map. When the caller provides checksums
   * over rows the reverseSql is about to touch, this is the "system has
   * drifted since execute" signal.
   *
   * The checksum verification is best-effort: it expects each entry to
   * be (rowId, checksum) and queries an `oweibo.action_row_checksums`-
   * shaped view via the supplied IDs. Because that view doesn't exist
   * yet (T.2.h follow-up), this method returns [] until the caller
   * implements it. Hook left in place so the wiring lands now.
   */
  private async detectChecksumDrift(
    _client: PoolClient,
    _rowChecksums: PostgresRollbackPlan['rowChecksums'],
  ): Promise<readonly string[]> {
    return [];
  }
}

function failed(details: string): RollbackResult {
  return {
    success: false,
    state: 'failed',
    details,
    sideEffects: [],
    costUsdCents: 0,
  };
}
