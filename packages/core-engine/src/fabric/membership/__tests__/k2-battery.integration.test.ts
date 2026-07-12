/**
 * K.2 exit-gate battery (roadmap K.2; ADR-010 §3.2/§3.6):
 *   (a) tenant bootstrap materializes principals + nested-group memberships
 *   (b) a group change produces MembershipChanged and a membership_version
 *       bump within the polling interval (here: on the next delta sync)
 *   (c) installing a content connector before the IdP connector is
 *       rejected with a clear error; installing after activation succeeds
 *   (d) RLS: tenant B sees neither tenant A's seeds nor edges (INV-12)
 *   (e) delta syncs enqueue in the class-1 lane, bootstrap in class-2 (INV-9)
 *
 * The battery drives a local fixture port, NOT @oweibo/connectors — the
 * engine importing a connector is precisely what INV-17 forbids; the real
 * google-workspace-idp adapter proves itself against the same port
 * contract in its own package.
 *
 * Prerequisites: TEST_DATABASE_URL with migrations ≥ 000065, connecting
 * as a non-BYPASSRLS role (oweibo_app). Skips cleanly without it.
 */
import { Pool, type PoolClient } from 'pg';
import { MembershipSyncService, type SyncPrincipalsPort, type SyncSourceGroup, type SyncSourcePrincipal } from '../MembershipSyncService';
import { JobQueue } from '../../scheduler/JobQueue';
import {
  PgTenantConnectorService,
  IdpConnectorRequiredError,
} from '../../../connector/PgTenantConnectorService';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

/** Mutable in-memory directory exposed through the port shape. */
class FixtureDirectory implements SyncPrincipalsPort<unknown> {
  principals: SyncSourcePrincipal[] = [];
  groups: SyncSourceGroup[] = [];
  private readonly pageSize = 2;

  async listPrincipals(_ctx: unknown, cursor: string | null) {
    return this.page(this.principals, cursor);
  }
  async listGroups(_ctx: unknown, cursor: string | null) {
    return this.page(this.groups, cursor);
  }
  private page<T>(items: readonly T[], cursor: string | null) {
    const offset = cursor === null ? 0 : Number(cursor);
    const slice = items.slice(offset, offset + this.pageSize);
    const next = offset + slice.length;
    return { items: slice, nextCursor: next < items.length ? String(next) : null };
  }
}

describeOrSkip('K.2 membership battery (ADR-010)', () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  const SOURCE = 'google-workspace-idp';

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE platform_admin`);
      return await fn(client);
    } finally {
      await client.query(`RESET ROLE`).catch(() => undefined);
      client.release();
    }
  }

  async function withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET app.tenant_id = '${tenantId}'`);
      return await fn(client);
    } finally {
      await client.query(`RESET app.tenant_id`).catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const seeded = await withPlatformAdmin(async (c) => {
      const a = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant A', 'tenant-a-k2-battery', '{}') RETURNING id`,
      );
      const b = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant B', 'tenant-b-k2-battery', '{}') RETURNING id`,
      );
      return { a: a.rows[0].id as string, b: b.rows[0].id as string };
    });
    tenantA = seeded.a;
    tenantB = seeded.b;
  });

  afterAll(async () => {
    // Tenant delete cascades kf_* rows and tenant_connectors.
    await withPlatformAdmin((c) =>
      c.query(`DELETE FROM oweibo.tenants WHERE slug IN ('tenant-a-k2-battery','tenant-b-k2-battery')`),
    );
    await pool.end();
  });

  function seededFixture(): FixtureDirectory {
    const dir = new FixtureDirectory();
    dir.principals = [
      { id: 'u-ada', email: 'ada@acme.test', displayName: 'Ada', status: 'active' },
      { id: 'u-bob', email: 'bob@acme.test', status: 'suspended' },
      { id: 'u-eve', email: 'eve@acme.test', status: 'active' },
    ];
    dir.groups = [
      { id: 'g-eng', memberPrincipals: ['u-ada'], memberGroups: ['g-core'] },
      { id: 'g-core', memberPrincipals: ['u-eve'], memberGroups: [] },
      { id: 'g-all', memberPrincipals: ['u-bob'], memberGroups: ['g-eng'] },
    ];
    return dir;
  }

  it('(a) bootstrap materializes principals + nested-group membership edges and emits', async () => {
    const svc = new MembershipSyncService(pool);
    const dir = seededFixture();

    const r = await svc.sync({ tenantId: tenantA, source: SOURCE, port: dir, ctx: {} });
    expect(r.principalsUpserted).toBe(3);
    expect(r.edgesAdded).toBe(5);          // 3 user edges + 2 nested group edges
    expect(r.edgesRemoved).toBe(0);
    expect(r.membershipVersion).toBe(1);
    expect(r.emitted).toBe(true);

    await withTenant(tenantA, async (c) => {
      const seeds = await c.query(
        `SELECT principal_ref, verified_email, status FROM oweibo.kf_principal_seeds
          WHERE tenant_id = $1::uuid AND source = $2 ORDER BY principal_ref`,
        [tenantA, SOURCE],
      );
      expect(seeds.rows).toHaveLength(3);
      expect(seeds.rows.find((x) => x.principal_ref === 'u-bob')?.status).toBe('suspended');

      const edges = await c.query(
        `SELECT principal_ref, group_ref FROM oweibo.kf_membership_records
          WHERE tenant_id = $1::uuid AND source = $2 ORDER BY group_ref, principal_ref`,
        [tenantA, SOURCE],
      );
      // Nesting stored as raw edges: g-core∈g-eng, g-eng∈g-all.
      // (Sorted by group_ref, then principal_ref.)
      expect(edges.rows).toEqual([
        { principal_ref: 'g-eng', group_ref: 'g-all' },
        { principal_ref: 'u-bob', group_ref: 'g-all' },
        { principal_ref: 'u-eve', group_ref: 'g-core' },
        { principal_ref: 'g-core', group_ref: 'g-eng' },
        { principal_ref: 'u-ada', group_ref: 'g-eng' },
      ]);
    });

    const events = await pool.query(
      `SELECT payload FROM oweibo.outbox
        WHERE subject = 'MembershipChanged' AND payload->>'tenantId' = $1`,
      [tenantA],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.membershipVersion).toBe(1);
  });

  it('(b) a group change produces MembershipChanged + a version bump on the next sync', async () => {
    const svc = new MembershipSyncService(pool);
    const dir = seededFixture();
    // The "group change in Workspace": eve joins g-eng, bob leaves g-all.
    dir.groups = dir.groups.map((g) => {
      if (g.id === 'g-eng') return { ...g, memberPrincipals: ['u-ada', 'u-eve'] };
      if (g.id === 'g-all') return { ...g, memberPrincipals: [] };
      return g;
    });

    const r = await svc.sync({ tenantId: tenantA, source: SOURCE, port: dir, ctx: {} });
    expect(r.edgesAdded).toBe(1);
    expect(r.edgesRemoved).toBe(1);
    expect(r.membershipVersion).toBe(2);   // the bump
    expect(r.emitted).toBe(true);

    const events = await pool.query(
      `SELECT payload FROM oweibo.outbox
        WHERE subject = 'MembershipChanged' AND payload->>'tenantId' = $1
        ORDER BY ts`,
      [tenantA],
    );
    expect(events.rows).toHaveLength(2);
    const delta = events.rows[1].payload;
    expect(delta.membershipVersion).toBe(2);
    expect(delta.affectedGroupRefs.sort()).toEqual(['g-all', 'g-eng']);

    // Idempotent follow-up: nothing changed → no event, version stable.
    const again = await svc.sync({ tenantId: tenantA, source: SOURCE, port: dir, ctx: {} });
    expect(again.emitted).toBe(false);
    expect(again.membershipVersion).toBe(2);
  });

  it('(c) content-connector install is blocked before the IdP is active, allowed after', async () => {
    const svc = new PgTenantConnectorService(pool, {
      identityConnectorIds: ['google-workspace-idp'],
    });

    // Drive before IdP: refused with the named dependency.
    await expect(svc.install({
      tenantId: tenantA, connectorId: 'google-drive', catalogVersion: '1',
      instanceLabel: 'drive-main', vaultPath: 'kv/t/a/drive', installedBy: null,
    })).rejects.toMatchObject({ code: 'install_blocked_idp_required' });

    // IdP itself installs freely (it IS the dependency) — status pending.
    await svc.install({
      tenantId: tenantA, connectorId: 'google-workspace-idp', catalogVersion: '1.0.0',
      instanceLabel: 'idp-main', vaultPath: 'kv/t/a/idp', installedBy: null,
    });

    // Still pending ≠ Healthy: content install stays blocked.
    await expect(svc.install({
      tenantId: tenantA, connectorId: 'google-drive', catalogVersion: '1',
      instanceLabel: 'drive-main', vaultPath: 'kv/t/a/drive', installedBy: null,
    })).rejects.toBeInstanceOf(IdpConnectorRequiredError);

    // validateConnection would promote pending → active; simulate that.
    await withTenant(tenantA, (c) =>
      c.query(
        `UPDATE oweibo.tenant_connectors SET status = 'active'
          WHERE tenant_id = $1::uuid AND connector_id = 'google-workspace-idp'`,
        [tenantA],
      ),
    );

    const drive = await svc.install({
      tenantId: tenantA, connectorId: 'google-drive', catalogVersion: '1',
      instanceLabel: 'drive-main', vaultPath: 'kv/t/a/drive', installedBy: null,
    });
    expect(drive.status).toBe('pending');
  });

  it('(d) RLS: tenant B sees neither tenant A seeds nor edges', async () => {
    await withTenant(tenantB, async (c) => {
      const seeds = await c.query(
        `SELECT 1 FROM oweibo.kf_principal_seeds WHERE tenant_id = $1::uuid`,
        [tenantA],
      );
      const edges = await c.query(
        `SELECT 1 FROM oweibo.kf_membership_records WHERE tenant_id = $1::uuid`,
        [tenantA],
      );
      expect(seeds.rowCount).toBe(0);
      expect(edges.rowCount).toBe(0);
    });
  });

  it('(e) delta syncs enqueue class-1, bootstrap class-2, duplicates are no-ops', async () => {
    const svc = new MembershipSyncService(pool);
    await withTenant(tenantA, async (c) => {
      const queue = new JobQueue(c);
      const boot = await svc.enqueueBootstrap(queue, tenantA, 'google-workspace-idp');
      const delta = await svc.enqueueDeltaSync(queue, tenantA, 'google-workspace-idp', 12345);
      const dup = await svc.enqueueDeltaSync(queue, tenantA, 'google-workspace-idp', 12345);
      expect(boot.enqueued).toBe(true);
      expect(delta.enqueued).toBe(true);
      expect(dup.enqueued).toBe(false);   // INV-6 idempotent no-op

      const rows = await c.query(
        `SELECT job_class, idempotency_key FROM oweibo.kf_jobs
          WHERE tenant_id = $1::uuid AND connector_id = 'google-workspace-idp'
          ORDER BY job_class`,
        [tenantA],
      );
      expect(rows.rows.map((r) => Number(r.job_class))).toEqual([1, 2]);
      expect(rows.rows[0].idempotency_key).toBe('membership_delta:google-workspace-idp:12345');
    });
  });
});
