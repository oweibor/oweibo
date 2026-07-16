/**
 * K.0 exit-gate battery (roadmap K.0; ADR-013 §7):
 *   (a) kill a worker mid-job → lease lapses → job re-runs from checkpoint
 *   (b) duplicate job (same idempotency key) is a no-op
 *   (c) stale fencing token rejected on write (INV-8)
 *   (d) class-1 jobs never starve under a class-4 flood (INV-9)
 *   (e) RLS: tenant A cannot read tenant B's jobs (INV-12)
 *
 * Prerequisites (matches packages/db rls.test.ts conventions):
 *   - TEST_DATABASE_URL points at Postgres with migrations ≥ 000060 applied
 *   - the connecting role is NOT a superuser / BYPASSRLS holder, so RLS binds
 *
 * Suite skips cleanly without TEST_DATABASE_URL.
 */
import { Pool, type PoolClient } from 'pg';
import { JobQueue } from '../JobQueue';
import { WorkerLease } from '../WorkerLease';
import { CheckpointManager } from '../CheckpointManager';
import { RetryManager } from '../RetryManager';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeOrSkip('K.0 scheduler battery (ADR-013)', () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;

  /**
   * Run fn carrying tenant RLS context at the SESSION level (not a single
   * transaction): each scheduler call inside fn auto-commits as its own
   * statement, so now() advances across steps exactly as it does in
   * production, where each operation is a separate transaction. Wrapping the
   * whole sequence in one BEGIN/COMMIT would freeze now() at transaction start
   * and defeat time-based lease expiry.
   */
  async function withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withContext(`SET app.tenant_id = '${tenantId}'`, `RESET app.tenant_id`, fn);
  }

  /**
   * Platform-admin context for seeding/cleaning tenants. The tenants bypass
   * policy requires CURRENT_USER = 'platform_admin' (hardened in migration
   * 000015); oweibo_app is a member of platform_admin (BYPASSRLS), so this is
   * the same SET ROLE escalation the shipped withTenantContext uses.
   */
  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withContext(`SET ROLE platform_admin`, `RESET ROLE`, fn);
  }

  async function withContext<T>(
    setStmt: string,
    resetStmt: string,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(setStmt);
      return await fn(client);
    } finally {
      // Reset session state before returning the client to the pool.
      await client.query(resetStmt).catch(() => undefined);
      client.release();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const seeded = await withPlatformAdmin(async (c) => {
      const a = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant A', 'tenant-a-k0-battery', '{}') RETURNING id`,
      );
      const b = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant B', 'tenant-b-k0-battery', '{}') RETURNING id`,
      );
      return { a: a.rows[0].id as string, b: b.rows[0].id as string };
    });
    tenantA = seeded.a;
    tenantB = seeded.b;
  });

  afterAll(async () => {
    await withPlatformAdmin((c) =>
      c.query(
        `DELETE FROM oweibo.tenants WHERE slug IN ('tenant-a-k0-battery','tenant-b-k0-battery')`,
      ),
    );
    await pool.end();
  });

  it('(b) duplicate enqueue with the same idempotency key is a no-op', async () => {
    await withTenant(tenantA, async (c) => {
      const q = new JobQueue(c);
      const first = await q.enqueue({
        tenantId: tenantA, connectorId: 'battery', jobClass: 2,
        idempotencyKey: 'doc-1:rev-7',
      });
      const dup = await q.enqueue({
        tenantId: tenantA, connectorId: 'battery', jobClass: 2,
        idempotencyKey: 'doc-1:rev-7',
      });
      expect(first.enqueued).toBe(true);
      expect(dup.enqueued).toBe(false);

      const count = await c.query(
        `SELECT COUNT(*)::int AS n FROM oweibo.kf_jobs WHERE idempotency_key = 'doc-1:rev-7'`,
      );
      expect(count.rows[0].n).toBe(1);
    });
  });

  it('(b2) blue/green claim: a version-tagged job is claimable only by a matching worker (ADR-004 §3.7)', async () => {
    await withTenant(tenantA, async (c) => {
      const q = new JobQueue(c);
      const { id } = await q.enqueue({
        tenantId: tenantA, connectorId: 'battery', jobClass: 2,
        idempotencyKey: 'bluegreen-tagged-1', connectorVersion: '1.4.0',
      });

      // A worker at the WRONG version (and a legacy version-less worker) must
      // not claim it — the SQL filter is the enforcement, not the pure rule.
      const wrong = await q.claim(50, '9.9.9');
      expect(wrong.find((j) => j.id === id)).toBeUndefined();
      const legacy = await q.claim(50);
      expect(legacy.find((j) => j.id === id)).toBeUndefined();

      // The matching worker claims it, and the tag rides along on the claim.
      const right = await q.claim(50, '1.4.0');
      const claimed = right.find((j) => j.id === id);
      expect(claimed).toBeDefined();
      expect(claimed!.connectorVersion).toBe('1.4.0');
    });
  });

  it('(a) lease lapse re-queues the job with its checkpoint intact', async () => {
    await withTenant(tenantA, async (c) => {
      const q = new JobQueue(c);
      const leases = new WorkerLease(c);
      const checkpoints = new CheckpointManager(c);

      const { id } = await q.enqueue({
        tenantId: tenantA, connectorId: 'battery', jobClass: 3,
        idempotencyKey: 'crawl-part-9',
      });
      const [job] = await q.claim(50).then((jobs) => jobs.filter((j) => j.id === id));
      expect(job).toBeDefined();

      // Worker takes a 1-second lease, checkpoints, then "dies" (no heartbeat).
      const lease = await leases.acquire({
        tenantId: tenantA, scope: `job:${id}`, holder: 'worker-1', ttlSeconds: 1,
      });
      expect(lease).not.toBeNull();
      const saved = await checkpoints.save({
        tenantId: tenantA, jobId: id!, checkpoint: { cursor: 'page-42' },
        presentedToken: lease!.fencingToken,
      });
      expect(saved.applied).toBe(true);

      await sleep(1_200); // lease lapses

      const requeued = await leases.sweepExpiredJobLeases();
      expect(requeued).toContain(id);

      // Re-claim: the job comes back WITH its checkpoint (resume, not restart).
      const reclaimed = await q.claim(50).then((jobs) => jobs.find((j) => j.id === id));
      expect(reclaimed).toBeDefined();
      expect(reclaimed!.checkpoint).toEqual({ cursor: 'page-42' });
      expect(reclaimed!.attempts).toBe(2);
    });
  }, 15_000);

  it('(c) a stale fencing token is rejected on write (INV-8)', async () => {
    await withTenant(tenantA, async (c) => {
      const q = new JobQueue(c);
      const leases = new WorkerLease(c);
      const checkpoints = new CheckpointManager(c);

      const { id } = await q.enqueue({
        tenantId: tenantA, connectorId: 'battery', jobClass: 3,
        idempotencyKey: 'exclusive-op-1',
      });
      await q.claim(50);

      const first = await leases.acquire({
        tenantId: tenantA, scope: `job:${id}`, holder: 'worker-1', ttlSeconds: 60,
      });
      expect(first).not.toBeNull();

      // Takeover: worker-1's lease is force-expired; worker-2 re-acquires.
      await leases.release(tenantA, `job:${id}`, 'worker-1');
      const second = await leases.acquire({
        tenantId: tenantA, scope: `job:${id}`, holder: 'worker-2', ttlSeconds: 60,
      });
      expect(second).not.toBeNull();
      expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);

      // worker-1's late write presents the old token → rejected.
      const stale = await checkpoints.save({
        tenantId: tenantA, jobId: id!, checkpoint: { cursor: 'zombie' },
        presentedToken: first!.fencingToken,
      });
      expect(stale).toEqual({ applied: false, reason: 'stale_fencing_token' });

      // worker-2's write with the current token succeeds.
      const fresh = await checkpoints.save({
        tenantId: tenantA, jobId: id!, checkpoint: { cursor: 'live' },
        presentedToken: second!.fencingToken,
      });
      expect(fresh.applied).toBe(true);
    });
  });

  it('(d) class-1 jobs claim first under a class-4 flood (INV-9)', async () => {
    await withTenant(tenantA, async (c) => {
      const q = new JobQueue(c);

      // Flood first, then the class-1 arrivals — created LATER on purpose.
      for (let i = 0; i < 30; i++) {
        await q.enqueue({
          tenantId: tenantA, connectorId: 'noisy', jobClass: 4,
          idempotencyKey: `backfill-${i}`,
        });
      }
      for (let i = 0; i < 3; i++) {
        await q.enqueue({
          tenantId: tenantA, connectorId: 'battery', jobClass: 1,
          idempotencyKey: `acl-${i}`,
        });
      }

      const batch = await q.claim(3);
      expect(batch).toHaveLength(3);
      // Every claimed job is class 1 despite 30 earlier class-4 arrivals.
      expect(batch.every((j) => j.jobClass === 1)).toBe(true);
    });
  });

  it("(e) tenant A cannot read tenant B's jobs (INV-12)", async () => {
    await withTenant(tenantB, async (c) => {
      const q = new JobQueue(c);
      await q.enqueue({
        tenantId: tenantB, connectorId: 'battery', jobClass: 2,
        idempotencyKey: 'b-private-job',
      });
    });

    const visible = await withTenant(tenantA, (c) =>
      c.query(`SELECT id FROM oweibo.kf_jobs WHERE tenant_id = $1::uuid`, [tenantB]),
    );
    expect(visible.rows).toHaveLength(0);

    const own = await withTenant(tenantB, (c) =>
      c.query(`SELECT id FROM oweibo.kf_jobs WHERE idempotency_key = 'b-private-job'`),
    );
    expect(own.rows).toHaveLength(1);
  });
});
