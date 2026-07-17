/**
 * CustomConnectorService — SOLE writer of `oweibo.custom_connector_manifests`
 * (INV-16: Integration Runtime, alongside Connector/CapabilityManifest).
 *
 * Registration is validation-gated (customManifest.ts) and idempotent per
 * (tenant, connectorId). A registered custom connector is installable through
 * the SAME PgTenantConnectorService.install path as a catalog entry — it gets
 * no special treatment downstream, which is the point:
 *
 *   - install-order gate: still requires an active identity connector first;
 *   - ADR-006 connector_enablement: absent ⇒ disabled, so ENABLING a custom
 *     connector for indexing/writes is a compliance relaxation that takes
 *     dual control — the strictest path in the platform, exactly where a
 *     tenant-authored integration belongs;
 *   - ADR-004 §3.7: deployments/blue-green apply to `custom.*` ids unchanged;
 *   - ADR-009 §3.6: the manifest's declaredTools is the AUTHORITY set for
 *     its MCP server — `admittedTools` runs the shipped inbound gate.
 *
 * Disable is soft (status='disabled'): new installs are refused; already-
 * installed instances remain visible in tenant_connectors for audit and are
 * governed by connector_enablement policy like everything else.
 */
import type { Pool, PoolClient } from 'pg';
import { gateInboundTools, type ManifestGateResult } from '../fabric/mcp/inboundGating.js';
import {
  InvalidCustomManifestError,
  validateCustomManifest,
  type CustomConnectorManifestInput,
} from './customManifest.js';

export interface CustomConnectorRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly displayName: string;
  readonly category: string;
  readonly description: string;
  readonly catalogVersion: string;
  readonly credentialSchema: unknown;
  readonly capabilities: readonly unknown[];
  readonly mcpServerUrl: string | null;
  readonly declaredTools: readonly string[];
  readonly certificationTarget: 'experimental';
  readonly status: 'registered' | 'disabled';
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class DuplicateCustomConnectorError extends Error {
  public readonly code = 'duplicate_custom_connector' as const;
  constructor(public readonly connectorId: string) {
    super(`custom connector ${connectorId} is already registered for this tenant`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CustomConnectorService {
  constructor(private readonly pool: Pool) {}

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
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

  /** Register a manifest. Throws InvalidCustomManifestError / DuplicateCustomConnectorError. */
  async register(input: {
    readonly tenantId: string;
    readonly createdBy: string;
    readonly manifest: CustomConnectorManifestInput;
  }): Promise<CustomConnectorRecord> {
    const violations = validateCustomManifest(input.manifest);
    if (violations.length > 0) throw new InvalidCustomManifestError(violations);

    const m = input.manifest;
    return this.withTenant(input.tenantId, async (c) => {
      let r;
      try {
        r = await c.query(
          `INSERT INTO oweibo.custom_connector_manifests
             (tenant_id, connector_id, display_name, category, description,
              catalog_version, credential_schema, capabilities,
              mcp_server_url, declared_tools, created_by)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::uuid)
           RETURNING *`,
          [
            input.tenantId, m.connectorId, m.displayName.trim(), m.category,
            m.description.trim(), m.catalogVersion,
            JSON.stringify(m.credentialSchema),
            JSON.stringify(m.capabilities ?? []),
            m.mcpServerUrl ?? null,
            JSON.stringify(m.declaredTools ?? []),
            input.createdBy,
          ],
        );
      } catch (err) {
        if (err instanceof Error && /custom_connector_manifests_unique_id|duplicate key/i.test(err.message)) {
          throw new DuplicateCustomConnectorError(m.connectorId);
        }
        throw err;
      }
      return toRecord(r.rows[0] as Record<string, unknown>);
    });
  }

  async list(tenantId: string): Promise<readonly CustomConnectorRecord[]> {
    const r = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT * FROM oweibo.custom_connector_manifests
          WHERE tenant_id = $1::uuid ORDER BY created_at DESC`,
        [tenantId],
      ),
    );
    return r.rows.map((row) => toRecord(row as Record<string, unknown>));
  }

  async get(tenantId: string, connectorId: string): Promise<CustomConnectorRecord | null> {
    const r = await this.withTenant(tenantId, (c) =>
      c.query(
        `SELECT * FROM oweibo.custom_connector_manifests
          WHERE tenant_id = $1::uuid AND connector_id = $2`,
        [tenantId, connectorId],
      ),
    );
    return r.rows[0] ? toRecord(r.rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Is this id installable right now? The install route consults the platform
   * catalog first, then this — a disabled manifest is NOT installable.
   */
  async installable(tenantId: string, connectorId: string): Promise<boolean> {
    const rec = await this.get(tenantId, connectorId);
    return rec !== null && rec.status === 'registered';
  }

  /** Soft-disable: refuses NEW installs; existing instances stay for audit. */
  async disable(tenantId: string, connectorId: string): Promise<boolean> {
    const r = await this.withTenant(tenantId, (c) =>
      c.query(
        `UPDATE oweibo.custom_connector_manifests
            SET status = 'disabled', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND connector_id = $2 AND status = 'registered'`,
        [tenantId, connectorId],
      ),
    );
    return (r.rowCount ?? 0) === 1;
  }

  /**
   * ADR-009 §3.6 — gate an MCP server's advertised tools against the
   * manifest's declared set. Only the intersection is callable; the
   * server-only remainder is an INV-15 divergence to flag.
   */
  async admittedTools(
    tenantId: string,
    connectorId: string,
    advertised: readonly string[],
  ): Promise<ManifestGateResult | null> {
    const rec = await this.get(tenantId, connectorId);
    if (!rec) return null;
    return gateInboundTools(advertised.map((name) => ({ name })), rec.declaredTools);
  }
}

function toRecord(row: Record<string, unknown>): CustomConnectorRecord {
  return {
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    connectorId: row['connector_id'] as string,
    displayName: row['display_name'] as string,
    category: row['category'] as string,
    description: row['description'] as string,
    catalogVersion: row['catalog_version'] as string,
    credentialSchema: row['credential_schema'],
    capabilities: (row['capabilities'] ?? []) as readonly unknown[],
    mcpServerUrl: (row['mcp_server_url'] ?? null) as string | null,
    declaredTools: (row['declared_tools'] ?? []) as readonly string[],
    certificationTarget: 'experimental',
    status: row['status'] as 'registered' | 'disabled',
    createdBy: (row['created_by'] ?? null) as string | null,
    createdAt: new Date(row['created_at'] as string | Date).toISOString(),
    updatedAt: new Date(row['updated_at'] as string | Date).toISOString(),
  };
}
