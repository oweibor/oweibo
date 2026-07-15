/**
 * K.9 / ADR-004 §3.7 — ConnectorUpgradeService. SOLE writer of
 * `oweibo.kf_connector_deployments` (INV-16), and the only writer of the
 * `kf_jobs.connector_version` blue/green tag.
 *
 * It wraps the shipped cohort model rather than reimplementing cohorts: a
 * canary targets a cohort channel, and a tenant is in the canary iff its
 * deployment's `tenant_cohort` matches (the cohort assignment itself is
 * CohortAdminService's, ADR-013's scheduler runs the tagged jobs).
 *
 * The exclusive upgrade OPERATION (state transition) is expected to run under a
 * kf_leases fencing token (INV-8) the same way rotation does — this service
 * performs the durable state change; the fencing guard is the caller's lease,
 * per ADR-004's rejection of advisory-lock-without-fencing.
 */
import type { Pool, PoolClient } from 'pg';
import {
  effectiveJobVersion,
  isLegalRolloutTransition,
  jobsToRetagOnRollback,
  type ConnectorDeployment,
  type RolloutState,
} from './rolloutContract.js';

export interface BeginCanaryInput {
  readonly connectorId: string;
  readonly targetVersion: string;
  readonly canaryCohort: string;
}

export class ConnectorUpgradeService {
  constructor(private readonly pool: Pool) {}

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET app.tenant_id = '${tenantId}'`);
      return await fn(client);
    } finally {
      await client.query(`RESET app.tenant_id`).catch(() => undefined);
      client.release();
    }
  }

  async deployment(tenantId: string, connectorId: string): Promise<ConnectorDeployment | null> {
    const r = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT tenant_id, connector_id, active_version, target_version, state, tenant_cohort, canary_cohort
           FROM oweibo.kf_connector_deployments
          WHERE tenant_id = $1::uuid AND connector_id = $2`,
        [tenantId, connectorId],
      ),
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      activeVersion: row.active_version,
      targetVersion: row.target_version ?? undefined,
      state: row.state as RolloutState,
      tenantCohort: row.tenant_cohort,
      canaryCohort: row.canary_cohort ?? undefined,
    };
  }

  /** Register a tenant's connector at an initial stable version. */
  async register(tenantId: string, connectorId: string, version: string, tenantCohort: string): Promise<void> {
    await this.withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO oweibo.kf_connector_deployments (tenant_id, connector_id, active_version, state, tenant_cohort)
         VALUES ($1::uuid, $2, $3, 'stable', $4)
         ON CONFLICT (tenant_id, connector_id) DO UPDATE
           SET active_version = EXCLUDED.active_version, tenant_cohort = EXCLUDED.tenant_cohort`,
        [tenantId, connectorId, version, tenantCohort],
      ),
    );
  }

  /**
   * The version a new job for this deployment must be tagged with. Enqueue paths
   * call this and write it to kf_jobs.connector_version — the blue/green tag.
   */
  async jobVersionFor(tenantId: string, connectorId: string): Promise<string | null> {
    const d = await this.deployment(tenantId, connectorId);
    return d ? effectiveJobVersion(d) : null;
  }

  /** §3.7 — begin a canary: cohort tenants start minting jobs at the target version. */
  async beginCanary(tenantId: string, input: BeginCanaryInput): Promise<{ ok: boolean; error?: string }> {
    const d = await this.deployment(tenantId, input.connectorId);
    if (!d) return { ok: false, error: 'not_registered' };
    if (!isLegalRolloutTransition(d.state, 'canary')) return { ok: false, error: `illegal transition ${d.state}→canary` };
    await this.withTenant(tenantId, (c) =>
      c.query(
        `UPDATE oweibo.kf_connector_deployments
            SET state = 'canary', target_version = $3, canary_cohort = $4, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND connector_id = $2`,
        [tenantId, input.connectorId, input.targetVersion, input.canaryCohort],
      ),
    );
    return { ok: true };
  }

  /** §3.7 — promote: the target version becomes active for this tenant. */
  async promote(tenantId: string, connectorId: string): Promise<{ ok: boolean; error?: string }> {
    const d = await this.deployment(tenantId, connectorId);
    if (!d) return { ok: false, error: 'not_registered' };
    if (!isLegalRolloutTransition(d.state, 'stable')) return { ok: false, error: `illegal transition ${d.state}→stable` };
    if (!d.targetVersion) return { ok: false, error: 'no_target' };
    await this.withTenant(tenantId, (c) =>
      c.query(
        `UPDATE oweibo.kf_connector_deployments
            SET active_version = target_version, target_version = NULL, canary_cohort = NULL,
                state = 'stable', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND connector_id = $2`,
        [tenantId, connectorId],
      ),
    );
    return { ok: true };
  }

  /**
   * §3.7 — rollback: re-tag QUEUED jobs at the target version back to the prior
   * (active) version, then return the deployment to stable. Leased jobs are left
   * to finish under their minted version (blue/green: rollback never yanks work
   * from a running worker).
   */
  async rollback(tenantId: string, connectorId: string): Promise<{ ok: boolean; retagged: number; error?: string }> {
    const d = await this.deployment(tenantId, connectorId);
    if (!d) return { ok: false, retagged: 0, error: 'not_registered' };
    if (!isLegalRolloutTransition(d.state, 'rolling_back')) {
      return { ok: false, retagged: 0, error: `illegal transition ${d.state}→rolling_back` };
    }
    if (!d.targetVersion) return { ok: false, retagged: 0, error: 'no_target' };

    return this.withTenant(tenantId, async (c) => {
      await c.query('BEGIN');
      try {
        // Mark rolling_back first (state guard), then re-tag queued jobs.
        await c.query(
          `UPDATE oweibo.kf_connector_deployments SET state = 'rolling_back', updated_at = NOW()
            WHERE tenant_id = $1::uuid AND connector_id = $2`,
          [tenantId, connectorId],
        );

        const queued = await c.query(
          `SELECT id, state, connector_version FROM oweibo.kf_jobs
            WHERE tenant_id = $1::uuid AND connector_id = $2 AND state = 'queued'`,
          [tenantId, connectorId],
        );
        const toRetag = jobsToRetagOnRollback(
          queued.rows.map((r) => ({ jobId: r.id, state: r.state, connectorVersion: r.connector_version })),
          d.targetVersion!,
          d.activeVersion,
        );
        if (toRetag.length > 0) {
          await c.query(
            `UPDATE oweibo.kf_jobs SET connector_version = $3, updated_at = NOW()
              WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid`,
            [toRetag, tenantId, d.activeVersion],
          );
        }

        // Resolve back to stable on the prior version.
        await c.query(
          `UPDATE oweibo.kf_connector_deployments
              SET state = 'stable', target_version = NULL, canary_cohort = NULL, updated_at = NOW()
            WHERE tenant_id = $1::uuid AND connector_id = $2`,
          [tenantId, connectorId],
        );

        await c.query('COMMIT');
        return { ok: true, retagged: toRetag.length };
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
  }
}
