/**
 * F.5.3 (ttv-finals): PgBanditPriorsSeeder adapter.
 *
 * Reads the K-anonymous platform_bandit_priors table (T.3.a aggregator
 * output), filters to prompt_slot scope, and writes one cold-start row
 * per (slot, channel) into oweibo.tenant_bandit_arms. Subsequent
 * BanditService.loadArms() lookups for the tenant pick up these synthetic
 * arms with the platform prior instead of starting from Beta(1,1).
 *
 * Mode awareness: bandit_learning operation requires platform mode >= 4.
 * When the current mode is lower, the seeder returns mode_too_low so the
 * bootstrap step records skipped (re-attempted by the reconciler on mode
 * promotion).
 *
 * Idempotency: ON CONFLICT (tenant_id, arm_id, slot_id, channel) DO
 * NOTHING. Re-running produces zero new rows.
 *
 * Empty priors: when the aggregator hasn't produced any prompt_slot rows
 * yet (or every row's contributor_count < the K-anonymity floor, which
 * the table-level CHECK already enforces), the seeder returns
 * no_priors_available and the step records ok (no work to do, not a
 * failure).
 */
import type { Pool, PoolClient } from 'pg';
import type { OperationalModeService } from '../../infrastructure/OperationalModeService.js';

export type PriorsSeedReason = 'ok' | 'no_priors_available' | 'mode_too_low' | 'failed';

export interface PriorsSeedResult {
  readonly reason: PriorsSeedReason;
  readonly armsSeeded: number;
  readonly slotsConsidered: number;
}

interface PriorRow {
  scope_key:         string;
  alpha_sum:         string;
  beta_sum:          string;
  contributor_count: number;
  catalog_version:   string;
}

const COLD_START_SOURCE = 'platform_prior';
const COLD_START_ARM_PREFIX = 'cold_start:';

export class PgBanditPriorsSeeder {
  constructor(
    private readonly pool: Pool,
    private readonly modes: OperationalModeService,
  ) {}

  /** Seed cold-start tenant_bandit_arms from the K-anonymous platform_bandit_priors table. */
  async seedPriors(tenantId: string): Promise<PriorsSeedResult> {
    const allowed = await this.modes.isAllowed('bandit_learning');
    if (!allowed) {
      return { reason: 'mode_too_low', armsSeeded: 0, slotsConsidered: 0 };
    }

    // F.7 review (A2): the aggregator writes per-region rows alongside
    // the '*' fallback (T.8 migration widened the PK to include
    // home_region). The prior implementation read every row regardless
    // of region, so per-scope_key it would pick a non-deterministic
    // winner. Now we read the tenant's home_region first, then
    // DISTINCT ON (scope_key) prefer the region-specific row over '*'.
    const tenant = await this.pool.query<{ home_region: string | null }>(
      `SELECT home_region FROM oweibo.tenants WHERE id = $1::uuid`,
      [tenantId],
    );
    const homeRegion = tenant.rows[0]?.home_region ?? '*';

    // Read priors that match the tenant's region OR the '*' fallback.
    // DISTINCT ON (scope_key) ORDER BY (home_region = $tenantRegion) DESC
    // picks the region-specific row when present, '*' otherwise. The
    // table's CHECK constraint enforces contributor_count >= 5
    // (K-anonymity) so any row that exists is safe to copy.
    const rows = await this.pool.query<PriorRow>(
      `SELECT DISTINCT ON (scope_key)
              scope_key, alpha_sum::text, beta_sum::text,
              contributor_count, catalog_version
         FROM oweibo.platform_bandit_priors
        WHERE scope_kind = 'prompt_slot'
          AND home_region IN ($1::text, '*')
        ORDER BY scope_key, (home_region = $1::text) DESC`,
      [homeRegion],
    );

    if (rows.rows.length === 0) {
      return { reason: 'no_priors_available', armsSeeded: 0, slotsConsidered: 0 };
    }

    let armsSeeded = 0;
    await this.tx(tenantId, async (client) => {
      for (const row of rows.rows) {
        const parsed = parseScopeKey(row.scope_key);
        if (!parsed) continue; // Malformed key — silently skip.
        const armId = `${COLD_START_ARM_PREFIX}${row.scope_key}`;
        const r = await client.query(
          `INSERT INTO oweibo.tenant_bandit_arms
             (tenant_id, arm_id, slot_id, channel, alpha, beta, source)
           VALUES ($1::uuid, $2, $3, $4, $5::numeric, $6::numeric, $7)
           ON CONFLICT (tenant_id, arm_id, slot_id, channel) DO NOTHING`,
          [tenantId, armId, parsed.slotId, parsed.channel, row.alpha_sum, row.beta_sum, COLD_START_SOURCE],
        );
        if (r.rowCount && r.rowCount > 0) armsSeeded += 1;
      }
    });

    return { reason: 'ok', armsSeeded, slotsConsidered: rows.rows.length };
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

interface ParsedScope { slotId: string; channel: string }

function parseScopeKey(key: string): ParsedScope | null {
  // Per T.3.a: scope_key = role || ':' || slot_id || ':' || channel
  const parts = key.split(':');
  if (parts.length < 3) return null;
  const channel = parts[parts.length - 1]!;
  const slotId  = parts[parts.length - 2]!;
  if (!slotId || !channel) return null;
  return { slotId, channel };
}
