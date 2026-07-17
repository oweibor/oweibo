/**
 * Custom connectors — LIVE end-to-end against Postgres:
 *
 *   register (validated manifest) → install through the SAME
 *   PgTenantConnectorService path as a catalog entry (real install-order
 *   gate: an active IdP row must exist first) → duplicate register 409-class
 *   error → disable → new installs refused → inbound MCP tool gating admits
 *   ONLY the declared set (ADR-009 §3.6 / INV-15).
 *
 * Skips cleanly without TEST_DATABASE_URL.
 */
import { Pool, type PoolClient } from 'pg';
import { CustomConnectorService, DuplicateCustomConnectorError } from '../CustomConnectorService';
import { InvalidCustomManifestError } from '../customManifest';
import { PgTenantConnectorService, IdpConnectorRequiredError } from '../PgTenantConnectorService';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

const MANIFEST = {
  connectorId: 'custom.acme-tracker',
  displayName: 'Acme Tracker',
  category: 'custom',
  description: 'Internal issue tracker.',
  catalogVersion: '1.0.0',
  credentialSchema: { type: 'object', required: ['api_key'], properties: { api_key: { type: 'string' } } },
  capabilities: [
    { capabilityId: 'create_ticket', summary: 'Create a ticket', actionClass: 'write.external_api.nonprod' },
  ],
  mcpServerUrl: 'https://mcp.acme.internal/tracker',
  declaredTools: ['tracker.search', 'tracker.create'],
} as const;

describeOrSkip('custom connectors — register → install → disable (live)', () => {
  let pool: Pool;
  let tenant: string;
  let admin: string;

  const svc = () => new CustomConnectorService(pool);
  const installer = () =>
    new PgTenantConnectorService(pool, { identityConnectorIds: ['google-workspace-idp'] });

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET ROLE platform_admin`); return await fn(client); }
    finally { await client.query(`RESET ROLE`).catch(() => undefined); client.release(); }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    ({ tenant, admin } = await withPlatformAdmin(async (c) => {
      const t = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant CustomConn', 'tenant-customconn-battery', '{}') RETURNING id`,
      );
      const u = await c.query(
        `INSERT INTO oweibo.users (id, email) VALUES (gen_random_uuid(), 'customconn@acme.test') RETURNING id`,
      );
      return { tenant: t.rows[0].id as string, admin: u.rows[0].id as string };
    }));
  });

  afterAll(async () => {
    await withPlatformAdmin(async (c) => {
      await c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-customconn-battery'`);
      await c.query(`DELETE FROM oweibo.users WHERE email = 'customconn@acme.test'`);
    });
    await pool.end();
  });

  it('(1) registers a valid manifest at the experimental tier; rejects an invalid one', async () => {
    const rec = await svc().register({ tenantId: tenant, createdBy: admin, manifest: MANIFEST });
    expect(rec.connectorId).toBe('custom.acme-tracker');
    expect(rec.certificationTarget).toBe('experimental');
    expect(rec.status).toBe('registered');

    await expect(
      svc().register({
        tenantId: tenant, createdBy: admin,
        manifest: { ...MANIFEST, connectorId: 'no-prefix' },
      }),
    ).rejects.toThrow(InvalidCustomManifestError);

    await expect(
      svc().register({ tenantId: tenant, createdBy: admin, manifest: MANIFEST }),
    ).rejects.toThrow(DuplicateCustomConnectorError);
  });

  it('(2) install-order gate applies to custom connectors UNCHANGED: no IdP, no install', async () => {
    await expect(
      installer().install({
        tenantId: tenant, connectorId: 'custom.acme-tracker', catalogVersion: '1.0.0',
        instanceLabel: 'primary', vaultPath: `tenants/${tenant}/connectors/acme`, installedBy: admin,
      }),
    ).rejects.toThrow(IdpConnectorRequiredError);
  });

  it('(3) with an active IdP, a registered custom connector installs like a catalog entry', async () => {
    await withPlatformAdmin((c) =>
      c.query(
        `INSERT INTO oweibo.tenant_connectors
           (tenant_id, connector_id, catalog_version, instance_label, vault_path, status)
         VALUES ($1::uuid, 'google-workspace-idp', '1', 'primary', 'tenants/x/idp', 'active')`,
        [tenant],
      ),
    );
    const row = await installer().install({
      tenantId: tenant, connectorId: 'custom.acme-tracker', catalogVersion: '1.0.0',
      instanceLabel: 'primary', vaultPath: `tenants/${tenant}/connectors/acme`, installedBy: admin,
    });
    expect(row.connectorId).toBe('custom.acme-tracker');
    expect(row.status).toBe('pending');
  });

  it('(4) disable refuses NEW installs (installable=false) but keeps the manifest for audit', async () => {
    expect(await svc().installable(tenant, 'custom.acme-tracker')).toBe(true);
    expect(await svc().disable(tenant, 'custom.acme-tracker')).toBe(true);
    expect(await svc().installable(tenant, 'custom.acme-tracker')).toBe(false);
    const rec = await svc().get(tenant, 'custom.acme-tracker');
    expect(rec?.status).toBe('disabled');
    // Disabling twice is a no-op (conditional transition).
    expect(await svc().disable(tenant, 'custom.acme-tracker')).toBe(false);
  });

  it('(5) inbound MCP gating: only DECLARED tools are admitted; server-only extras are divergences', async () => {
    const gate = await svc().admittedTools(tenant, 'custom.acme-tracker', [
      'tracker.search',           // declared → admitted
      'tracker.create',           // declared → admitted
      'tracker.delete_everything' // advertised only → dropped + flagged (INV-15)
    ]);
    expect(gate).not.toBeNull();
    expect(gate!.admitted).toEqual(['tracker.search', 'tracker.create']);
    expect(gate!.divergences).toEqual(['tracker.delete_everything']);
  });

  it('(6) RLS: another tenant sees nothing of this tenant\'s custom manifests', async () => {
    const other = await withPlatformAdmin(async (c) => {
      const t = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant CustomConn B', 'tenant-customconn-b-battery', '{}') RETURNING id`,
      );
      return t.rows[0].id as string;
    });
    try {
      expect(await svc().list(other)).toEqual([]);
      expect(await svc().get(other, 'custom.acme-tracker')).toBeNull();
    } finally {
      await withPlatformAdmin((c) =>
        c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-customconn-b-battery'`),
      );
    }
  });
});
