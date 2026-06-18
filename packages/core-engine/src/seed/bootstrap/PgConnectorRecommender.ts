/**
 * F.5.1 (ttv-finals): PgConnectorRecommender adapter.
 *
 * Implements the bootstrap-worker's IConnectorRecommender shape: given a
 * (tenantId, templateSlug, industry?) tuple, ask ConnectorRegistry for
 * matching catalog entries and write one row per recommendation into
 * oweibo.tenant_connectors with status='recommended'.
 *
 * Idempotency: ON CONFLICT (tenant_id, connector_id, instance_label) DO
 * NOTHING. Re-running the bootstrap pipeline produces zero new rows after
 * first success. Operators promote recommended → active by supplying
 * credentials via the tenant connectors admin surface (F.4.7).
 *
 * Vault paths: deterministic `oweibo/tenants/<tenantId>/connectors/<id>/default`.
 * Credentials are NOT written by this adapter — only the placeholder pointer.
 */
import type { Pool, PoolClient } from 'pg';
import type { ConnectorRegistry } from '../../connector/ConnectorRegistry.js';

export interface ConnectorRecommendation {
  readonly connectorId: string;
  readonly displayName: string;
}

export interface PgConnectorRecommenderResult {
  readonly inserted: number;
  readonly skippedExisting: number;
  readonly recommendations: readonly ConnectorRecommendation[];
}

const DEFAULT_INSTANCE_LABEL = 'default';

export class PgConnectorRecommender {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly pool: Pool,
  ) {}

  /** Compute recommendations for a tenant and persist them as `status='recommended'` rows. */
  async recommend(
    tenantId: string,
    templateSlug: string,
    industry?: string,
  ): Promise<ConnectorRecommendation[]> {
    const result = await this.recommendWithCounts(tenantId, templateSlug, industry);
    return [...result.recommendations];
  }

  /** Same as recommend(), but exposes inserted vs. skipped-existing counts for the admin UI. */
  async recommendWithCounts(
    tenantId: string,
    templateSlug: string,
    industry?: string,
  ): Promise<PgConnectorRecommenderResult> {
    const matches = this.registry.recommend(templateSlug, industry);
    const recommendations: ConnectorRecommendation[] = matches.map((e) => ({
      connectorId: e.connectorId,
      displayName: e.displayName,
    }));

    let inserted = 0;
    let skippedExisting = 0;

    if (matches.length === 0) {
      return { inserted, skippedExisting, recommendations };
    }

    await this.tx(tenantId, async (client) => {
      for (const entry of matches) {
        const vaultPath = `oweibo/tenants/${tenantId}/connectors/${entry.connectorId}/${DEFAULT_INSTANCE_LABEL}`;
        const r = await client.query(
          `INSERT INTO oweibo.tenant_connectors
             (tenant_id, connector_id, catalog_version, instance_label, vault_path, status, metadata)
           VALUES ($1::uuid, $2, $3, $4, $5, 'recommended', $6::jsonb)
           ON CONFLICT ON CONSTRAINT tenant_connectors_unique_instance DO NOTHING`,
          [
            tenantId,
            entry.connectorId,
            entry.catalogVersion,
            DEFAULT_INSTANCE_LABEL,
            vaultPath,
            JSON.stringify({
              recommendedAt: new Date().toISOString(),
              templateSlug,
              ...(industry ? { industry } : {}),
            }),
          ],
        );
        if (r.rowCount && r.rowCount > 0) inserted += 1;
        else skippedExisting += 1;
      }
    });

    return { inserted, skippedExisting, recommendations };
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
