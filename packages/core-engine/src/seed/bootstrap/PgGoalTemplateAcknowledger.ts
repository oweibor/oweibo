/**
 * F.5.2 (ttv-finals): PgGoalTemplateAcknowledger adapter.
 *
 * Filters the GoalTemplateCatalog for templates applicable to the tenant
 * (template slug + optional industry), then upserts one row per match
 * into oweibo.tenant_goal_templates_ack. The catalog itself is cross-
 * tenant (oweibo.goal_templates); this adapter only writes the per-
 * tenant ack log used by the onboarding-status route to count
 * acknowledged templates.
 *
 * Idempotency: ON CONFLICT (tenant_id, slug) DO UPDATE catalog_version /
 * acknowledged_at. Re-running after a catalog version bump replaces the
 * old ack with the new version observed.
 *
 * Catalog version: each row records the catalog version observed at ack
 * time so admins can see which template-set version the tenant matched
 * against — useful when investigating why an old tenant didn't pick up
 * a newer template.
 */
import type { Pool, PoolClient } from 'pg';
import { GoalTemplateCatalog } from '../GoalTemplateCatalog.js';

export interface GoalTemplateAckResult {
  /** How many templates would apply for this tenant. */
  readonly applicableCount: number;
  /** The catalog version observed at ack time (or 'empty' if no entries). */
  readonly catalogVersion: string;
  /** New ack rows inserted this call. */
  readonly inserted: number;
  /** Existing ack rows whose catalog_version was rewritten this call. */
  readonly updated: number;
}

const ACK_SOURCE = 'bootstrap';

export class PgGoalTemplateAcknowledger {
  constructor(
    private readonly catalog: GoalTemplateCatalog,
    private readonly pool: Pool,
  ) {}

  /** Upsert a per-tenant ack row for every catalog template that applies to the tenant's slug + industry. */
  async acknowledge(
    tenantId: string,
    templateSlug: string,
    industry?: string,
  ): Promise<GoalTemplateAckResult> {
    const matches = this.catalog.forTenant({ templateSlug, ...(industry ? { industry } : {}) });
    if (matches.length === 0) {
      return { applicableCount: 0, catalogVersion: 'empty', inserted: 0, updated: 0 };
    }

    // All entries within a single catalog directory share a catalogVersion
    // — pick the first as the canonical observed version for this ack
    // batch. Mixed-version catalogs are a misconfiguration the loader
    // currently allows but the ack log records the *first* version
    // observed which is sufficient for the audit trail.
    const observedVersion = matches[0]!.catalogVersion;

    let inserted = 0;
    let updated = 0;

    await this.tx(tenantId, async (client) => {
      for (const tpl of matches) {
        const r = await client.query<{ xmax: string }>(
          `INSERT INTO oweibo.tenant_goal_templates_ack
             (tenant_id, slug, catalog_version, source, acknowledged_at)
           VALUES ($1::uuid, $2, $3, $4, NOW())
           ON CONFLICT (tenant_id, slug) DO UPDATE
             SET catalog_version = EXCLUDED.catalog_version,
                 acknowledged_at = NOW(),
                 source          = EXCLUDED.source
           RETURNING xmax::text`,
          [tenantId, tpl.templateId, tpl.catalogVersion, ACK_SOURCE],
        );
        // xmax = 0 means a fresh INSERT; non-zero means UPDATE path.
        if (r.rows[0]?.xmax === '0') inserted += 1;
        else updated += 1;
      }
    });

    return { applicableCount: matches.length, catalogVersion: observedVersion, inserted, updated };
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
