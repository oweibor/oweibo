/**
 * F.4.7: PgTenantConnectorService — CRUD over `oweibo.tenant_connectors`,
 * the per-tenant catalog of installed connector instances.
 *
 * Schema-side responsibilities live in T.2.f / D.4 (ConnectorRegistry is
 * the platform catalog, this row table is the per-tenant install index).
 *
 *   - `listForTenant` → admin connectors page.
 *   - `install`       → POST /tenants/:tenantId/connectors.
 *                       Optional pre-install credential probe via
 *                       IVaultClient.read(vaultPath) — fails closed
 *                       when the path is empty so the admin doesn't
 *                       land an unusable row.
 *
 * Status defaults to 'pending'. Promotion to 'active' happens on first
 * successful credential resolve (CredentialResolver wires that path);
 * 'suspended' / 'revoked' are operator-driven and out of scope here.
 */
import type { Pool, PoolClient } from 'pg';
import type { IVaultClient } from './CredentialResolver.js';

export type TenantConnectorStatus = 'pending' | 'active' | 'suspended' | 'revoked';

export interface InstalledConnectorRow {
  readonly id: string;
  readonly connectorId: string;
  readonly catalogVersion: string;
  readonly instanceLabel: string;
  readonly status: TenantConnectorStatus;
  readonly installedBy: string | null;
  readonly installedAt: string;
  readonly lastUsedAt: string | null;
  /**
   * vault_path is metadata the admin UI displays for debugging; the
   * actual credentials are NEVER returned by this service.
   */
  readonly vaultPath: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface InstallRequest {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly catalogVersion: string;
  readonly instanceLabel: string;
  readonly vaultPath: string;
  readonly installedBy: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PgTenantConnectorServiceOptions {
  /**
   * When set, install() verifies the vaultPath has a non-null secret
   * before writing the row. Wire to the same IVaultClient used by
   * CredentialResolver. Omit in dev / tests where Vault is absent.
   */
  vault?: IVaultClient;
}

export class CredentialNotResolvableError extends Error {
  public readonly code = 'credential_not_resolvable' as const;
  constructor(public readonly vaultPath: string) {
    super(`credential_not_resolvable at ${vaultPath}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DuplicateConnectorInstanceError extends Error {
  public readonly code = 'duplicate_connector_instance' as const;
  constructor(public readonly connectorId: string, public readonly instanceLabel: string) {
    super(`duplicate_connector_instance: ${connectorId}/${instanceLabel}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PgTenantConnectorService {
  private readonly vault: IVaultClient | undefined;

  constructor(private readonly pool: Pool, opts: PgTenantConnectorServiceOptions = {}) {
    this.vault = opts.vault;
  }

  async listForTenant(tenantId: string): Promise<readonly InstalledConnectorRow[]> {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<{
        id: string;
        connector_id: string;
        catalog_version: string;
        instance_label: string;
        status: TenantConnectorStatus;
        installed_by: string | null;
        installed_at: Date;
        last_used_at: Date | null;
        vault_path: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, connector_id, catalog_version, instance_label,
                status, installed_by, installed_at, last_used_at,
                vault_path, metadata
           FROM oweibo.tenant_connectors
          WHERE tenant_id = $1::uuid
          ORDER BY installed_at DESC`,
        [tenantId],
      );
      return r.rows.map((row) => ({
        id: row.id,
        connectorId: row.connector_id,
        catalogVersion: row.catalog_version,
        instanceLabel: row.instance_label,
        status: row.status,
        installedBy: row.installed_by,
        installedAt: row.installed_at.toISOString(),
        lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
        vaultPath: row.vault_path,
        metadata: row.metadata,
      }));
    });
  }

  async install(req: InstallRequest): Promise<InstalledConnectorRow> {
    if (this.vault) {
      const probe = await this.vault.read(req.vaultPath);
      if (!probe || Object.keys(probe).length === 0) {
        throw new CredentialNotResolvableError(req.vaultPath);
      }
    }
    return this.tx(req.tenantId, async (client) => {
      let r;
      try {
        r = await client.query<{
          id: string;
          installed_at: Date;
        }>(
          `INSERT INTO oweibo.tenant_connectors
             (tenant_id, connector_id, catalog_version, instance_label,
              vault_path, status, installed_by, installed_at, metadata)
           VALUES ($1::uuid, $2, $3, $4, $5, 'pending', $6, NOW(), $7::jsonb)
           RETURNING id, installed_at`,
          [
            req.tenantId,
            req.connectorId,
            req.catalogVersion,
            req.instanceLabel,
            req.vaultPath,
            req.installedBy,
            JSON.stringify(req.metadata ?? {}),
          ],
        );
      } catch (err) {
        if (err instanceof Error && /tenant_connectors_unique_instance|duplicate key/i.test(err.message)) {
          throw new DuplicateConnectorInstanceError(req.connectorId, req.instanceLabel);
        }
        throw err;
      }
      const row = r.rows[0];
      if (!row) throw new Error('PgTenantConnectorService.install: insert returned no row');
      return {
        id: row.id,
        connectorId: req.connectorId,
        catalogVersion: req.catalogVersion,
        instanceLabel: req.instanceLabel,
        status: 'pending',
        installedBy: req.installedBy,
        installedAt: row.installed_at.toISOString(),
        lastUsedAt: null,
        vaultPath: req.vaultPath,
        metadata: req.metadata ?? {},
      };
    });
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
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
