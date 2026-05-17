// D.1 — CohortAdminService: per-tenant cohort_channel administration.
//
// Surfaces (read + write):
//   - listTenants()        — every tenant with current cohort_channel + last change
//   - listChannels()       — distinct channels in oweibo.channels (live promotion targets)
//   - setTenantCohort()    — atomic update + audit row in oweibo.tenant_cohort_changes
//   - listRecentChanges()  — recent audit rows for the history panel
//   - resolveCohortFor()   — used by SwarmCoordinator at task start; falls back
//                            to 'stable-v0' if tenant_settings row is missing.

import type { Pool, PoolClient } from 'pg';

export interface TenantCohortRow {
  tenantId:         string;
  name:             string | null;
  cohortChannel:    string;
  lastChangedAt:    string | null;
  lastChangedBy:    string | null;
  lastChangeReason: string | null;
}

export interface CohortChangeRecord {
  id:              string;
  tenantId:        string;
  previousChannel: string;
  newChannel:      string;
  reason:          string;
  changedBy:       string;
  changedAt:       string;
}

export interface SetTenantCohortInput {
  tenantId:   string;
  newChannel: string;
  reason:     string;
  changedBy:  string;
}

export type SetTenantCohortResult =
  | { ok: true; previousChannel: string }
  | { ok: false; error: 'tenant_not_found' | 'unknown_channel' | 'no_change'; message: string };

export class CohortAdminService {
  constructor(private readonly pool: Pool) {}

  /**
   * Every tenant joined to its tenant_settings.cohort_channel.
   * Tenants without a settings row are surfaced with the default 'stable-v0'.
   */
  async listTenants(): Promise<TenantCohortRow[]> {
    const result = await this.pool.query<{
      tenant_id:         string;
      name:              string | null;
      cohort_channel:    string;
      last_changed_at:   string | null;
      last_changed_by:   string | null;
      last_change_reason: string | null;
    }>(
      `SELECT t.id                       AS tenant_id,
              t.name                     AS name,
              COALESCE(ts.cohort_channel, 'stable-v0') AS cohort_channel,
              h.changed_at               AS last_changed_at,
              h.changed_by               AS last_changed_by,
              h.reason                   AS last_change_reason
       FROM oweibo.tenants t
       LEFT JOIN oweibo.tenant_settings ts ON ts.tenant_id = t.id
       LEFT JOIN LATERAL (
         SELECT changed_at, changed_by, reason
         FROM oweibo.tenant_cohort_changes
         WHERE tenant_id = t.id
         ORDER BY changed_at DESC LIMIT 1
       ) h ON TRUE
       ORDER BY t.name NULLS LAST, t.id`,
    );
    return result.rows.map(r => ({
      tenantId:         r.tenant_id,
      name:             r.name,
      cohortChannel:    r.cohort_channel,
      lastChangedAt:    r.last_changed_at,
      lastChangedBy:    r.last_changed_by,
      lastChangeReason: r.last_change_reason,
    }));
  }

  /**
   * Distinct channel names actually present in oweibo.channels.
   * Plus the always-available 'stable-v0' baseline returned by CohortRouter
   * as the universal fallback.
   */
  async listChannels(): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      `SELECT DISTINCT name FROM oweibo.channels ORDER BY name`,
    );
    const channels = new Set<string>(['stable-v0']);
    for (const r of result.rows) channels.add(r.name);
    return Array.from(channels);
  }

  /** Atomic cohort change + audit. */
  async setTenantCohort(input: SetTenantCohortInput): Promise<SetTenantCohortResult> {
    const validChannels = await this.listChannels();
    if (!validChannels.includes(input.newChannel)) {
      return {
        ok:      false,
        error:   'unknown_channel',
        message: `Channel '${input.newChannel}' is not present in oweibo.channels (known: ${validChannels.join(', ')}).`,
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Ensure tenant exists
      const tenantRes = await client.query(
        `SELECT id FROM oweibo.tenants WHERE id = $1`,
        [input.tenantId],
      );
      if (tenantRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok:      false,
          error:   'tenant_not_found',
          message: `No tenant with id ${input.tenantId}.`,
        };
      }

      // Upsert tenant_settings row to capture the new channel; read prev value.
      const prevRes = await client.query<{ cohort_channel: string }>(
        `SELECT cohort_channel FROM oweibo.tenant_settings WHERE tenant_id = $1`,
        [input.tenantId],
      );
      const previousChannel = prevRes.rows[0]?.cohort_channel ?? 'stable-v0';

      if (previousChannel === input.newChannel) {
        await client.query('ROLLBACK');
        return {
          ok:      false,
          error:   'no_change',
          message: `Tenant is already on cohort '${input.newChannel}'.`,
        };
      }

      await upsertTenantCohort(client, input.tenantId, input.newChannel);

      await client.query(
        `INSERT INTO oweibo.tenant_cohort_changes
           (tenant_id, previous_channel, new_channel, reason, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.tenantId, previousChannel, input.newChannel, input.reason, input.changedBy],
      );

      await client.query('COMMIT');
      return { ok: true, previousChannel };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Most-recent cohort changes, newest first. */
  async listRecentChanges(limit = 50): Promise<CohortChangeRecord[]> {
    const result = await this.pool.query<{
      id:               string;
      tenant_id:        string;
      previous_channel: string;
      new_channel:      string;
      reason:           string;
      changed_by:       string;
      changed_at:       string;
    }>(
      `SELECT id, tenant_id, previous_channel, new_channel, reason, changed_by, changed_at
       FROM oweibo.tenant_cohort_changes
       ORDER BY changed_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(r => ({
      id:              r.id,
      tenantId:        r.tenant_id,
      previousChannel: r.previous_channel,
      newChannel:      r.new_channel,
      reason:          r.reason,
      changedBy:       r.changed_by,
      changedAt:       r.changed_at,
    }));
  }

  /**
   * Read-only resolution used by SwarmCoordinator at task start.
   * Always falls back to 'stable-v0' on missing tenant_settings or any error
   * — never throws into the task path (mirrors CohortRouter invariant §2.8).
   */
  async resolveCohortFor(tenantId: string): Promise<string> {
    try {
      const res = await this.pool.query<{ cohort_channel: string }>(
        `SELECT cohort_channel FROM oweibo.tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      return res.rows[0]?.cohort_channel ?? 'stable-v0';
    } catch {
      return 'stable-v0';
    }
  }
}

async function upsertTenantCohort(
  client: PoolClient,
  tenantId: string,
  newChannel: string,
): Promise<void> {
  await client.query(
    `INSERT INTO oweibo.tenant_settings (tenant_id, cohort_channel, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (tenant_id) DO UPDATE
       SET cohort_channel = EXCLUDED.cohort_channel,
           updated_at     = NOW()`,
    [tenantId, newChannel],
  );
}
