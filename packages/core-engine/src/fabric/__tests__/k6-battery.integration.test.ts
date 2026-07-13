/**
 * K.6 exit-gate battery (roadmap K.6; ADR-004 + ADR-008 armed). Against live
 * Postgres, with a fixture live-read port (the real MCP client is the
 * unexercised half, like live-Google). Gates:
 *   (1) a "has finance approved X?"-shaped Critical query goes LIVE end-to-end
 *       and composes the field-disjoint result (index title + live status);
 *   (2) §16.2 self-heal: live revision ahead of index → serve live, mark the
 *       object stale, emit ReindexRequested;
 *   (3) credential-kill (connector → Degraded) flips Critical to explicit
 *       WITHHOLDING — not stale serving — at the storage gate;
 *   (4) auto-resume needs Healthy AND one revalidation pass: `rotating`
 *       (revalidating) still withholds; Healthy-after-revalidation serves;
 *   (5) fan-out: top-k ranked connectors, a straggler past the read budget is
 *       cut and recorded (§7.6).
 *
 * Skips cleanly without TEST_DATABASE_URL. Fixture ports, not
 * @oweibo/connectors (INV-17).
 */
import { Pool, type PoolClient } from 'pg';
import { DiscoveryService, type SyncChangeEvent, type SyncChangeFeedPort } from '../discovery/DiscoveryService';
import { IndexingService, type SyncAclPort, type SyncContentPort } from '../indexing/IndexingService';
import { JobQueue } from '../scheduler/JobQueue';
import { LivePathService, type LiveConnectorCandidate, type LiveReadPort } from '../live/LivePathService';
import type { FieldFreshness } from '../live/fieldFreshness';
import { createHash } from 'crypto';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

interface FixtureDoc { fields: Record<string, unknown>; revision: number; grants: Array<{ principal: string; kind: 'user' | 'group'; access: string }>; }
class FixtureSource implements SyncChangeFeedPort<unknown>, SyncContentPort<unknown>, SyncAclPort<unknown> {
  readonly docs = new Map<string, FixtureDoc>();
  private readonly log: SyncChangeEvent[] = [];
  put(id: string, fields: Record<string, unknown>, grants: FixtureDoc['grants']): void {
    const prior = this.docs.get(id);
    const revision = (prior?.revision ?? 0) + 1;
    this.docs.set(id, { fields, revision, grants });
    this.log.push({ ref: id, kind: prior ? 'updated' : 'created', sourceRevision: String(revision) });
  }
  async listChanges(_c: unknown, cursor: string | null) {
    const offset = cursor === null ? 0 : Number(cursor);
    const items = this.log.slice(offset, offset + 10);
    return { items, nextCursor: String(offset + items.length) };
  }
  async fetchContent(_c: unknown, ref: string) { const d = this.docs.get(ref)!; return { fields: d.fields, revision: String(d.revision) }; }
  async fetchAcl(_c: unknown, ref: string) {
    const d = this.docs.get(ref)!;
    const canon = d.grants.map((g) => `${g.kind}:${g.principal}:${g.access}`).sort().join('\n');
    return { aclVersion: `sha256:${createHash('sha256').update(canon).digest('hex')}`, principals: d.grants };
  }
}

/** A live-read port backed by a mutable "source of truth" (SAP-like). */
class FixtureLivePort implements LiveReadPort<unknown> {
  constructor(private readonly state: { status: string; revision: number }, private readonly delayMs = 0) {}
  async readLive(_ctx: unknown, _documentId: string, fields: readonly string[]) {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const out: Record<string, unknown> = {};
    for (const f of fields) if (f === 'status') out[f] = this.state.status;
    return { fields: out, revision: this.state.revision };
  }
}

describeOrSkip('K.6 live-path battery (ADR-004 + ADR-008 armed)', () => {
  let pool: Pool;
  let tenant: string;
  let objectId: string;
  const CONNECTOR = 'sap';
  const SOURCE = 'sap';
  const source = new FixtureSource();
  let cursor: string | null = null;

  // "invoice 491": title is Operational (index-served), status is Critical (live-only).
  const fields: FieldFreshness[] = [
    { field: 'title', effectiveClass: 'operational', indexAgeMs: 1000 },
    { field: 'status', effectiveClass: 'critical', indexAgeMs: 1000 },
  ];

  async function withPlatformAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET ROLE platform_admin`); return await fn(client); }
    finally { await client.query(`RESET ROLE`).catch(() => undefined); client.release(); }
  }
  async function withTenant<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query(`SET app.tenant_id = '${tenant}'`); return await fn(client); }
    finally { await client.query(`RESET app.tenant_id`).catch(() => undefined); client.release(); }
  }

  async function runPipeline(): Promise<void> {
    const poll = await new DiscoveryService(pool).poll({ tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, port: source, ctx: {}, cursor });
    cursor = poll.nextCursor;
    await withTenant(async (c) => {
      const queue = new JobQueue(c);
      for (;;) {
        const jobs = await queue.claim(10);
        if (jobs.length === 0) break;
        for (const job of jobs) {
          const cp = job.checkpoint as { documentId: string; kind: SyncChangeEvent['kind']; sourceRevision: number };
          const res = await new IndexingService(pool).indexDocument({
            tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, documentId: cp.documentId,
            sourceRevision: Math.max(cp.sourceRevision, 1), kind: cp.kind, content: source, acl: source, ctx: {},
            freshnessClasses: { title: 'operational', status: 'critical' },
          });
          if (res.knowledgeObjectId) objectId = res.knowledgeObjectId;
          await queue.complete(job.id);
        }
      }
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    tenant = await withPlatformAdmin(async (c) => {
      const r = await c.query(`INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant K6', 'tenant-k6-battery', '{}') RETURNING id`);
      return r.rows[0].id as string;
    });
    // Indexed invoice: status was 'pending' at index revision 5.
    source.put('invoice-491', { title: 'Invoice 491', status: 'pending' },
      [{ principal: 'cfo@acme.test', kind: 'user', access: 'read' }]);
    // bump to revision 5 so the live revision (7) is clearly ahead.
    for (let i = 0; i < 4; i++) source.put('invoice-491', { title: 'Invoice 491', status: 'pending' }, [{ principal: 'cfo@acme.test', kind: 'user', access: 'read' }]);
    await runPipeline();
  });

  afterAll(async () => {
    await withPlatformAdmin((c) => c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-k6-battery'`));
    await pool.end();
  });

  const live = () => new LivePathService(pool);
  const healthy = (port: LiveReadPort<unknown>, over: Partial<LiveConnectorCandidate<unknown>> = {}): LiveConnectorCandidate<unknown> =>
    ({ connectorId: CONNECTOR, auth: 'healthy', healthScore: 0.9, port, ctx: {}, ...over });

  it('(1)+(2) Critical query goes live end-to-end; live-ahead → serve live + mark stale + ReindexRequested', async () => {
    // Source of truth now says approved at revision 7 (ahead of index rev 5).
    const sap = new FixtureLivePort({ status: 'approved', revision: 7 });
    const res = await live().livePathQuery({
      tenantId: tenant, source: SOURCE, documentId: 'invoice-491', knowledgeObjectId: objectId,
      fields, indexFields: { title: 'Invoice 491', status: 'pending' }, indexRevision: 5,
      connectors: [healthy(sap)],
    });
    expect(res.verdict).toBe('served');
    // Field-disjoint composition: index title + LIVE status.
    expect(res.composed).toEqual({ title: 'Invoice 491', status: 'approved' });
    expect(res.fieldPaths).toEqual({ title: 'index', status: 'live' });
    expect(res.conflictsHealed).toBe(1);
    expect(res.servedRevision).toBe(7);

    // §16.2 self-heal: the live path EMITS ReindexRequested (cause only — it
    // never writes KnowledgeObject state; that is the Knowledge Runtime's, INV-16).
    const events = await pool.query(`SELECT subject FROM oweibo.outbox WHERE payload->>'tenantId' = $1 AND subject = 'ReindexRequested'`, [tenant]);
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
    // The Knowledge Runtime (sole writer) reacts by marking the object stale.
    await new IndexingService(pool).markStale({ tenantId: tenant, connectorId: CONNECTOR, documentId: 'invoice-491' });
    const state = await withTenant((c) => c.query(`SELECT state FROM oweibo.kf_knowledge_objects WHERE id = $1::uuid`, [objectId]));
    expect(state.rows[0].state).toBe('stale');
    // Provenance row for the live-served result.
    const prov = await withTenant((c) => c.query(`SELECT retrieval_path FROM oweibo.kf_provenance WHERE retrieval_id = $1::uuid`, [res.retrievalId]));
    expect(prov.rows[0].retrieval_path).toBe('live');
  });

  it('(3) credential-kill → Degraded → Critical is WITHHELD, not served stale', async () => {
    const sap = new FixtureLivePort({ status: 'approved', revision: 7 });
    const res = await live().livePathQuery({
      tenantId: tenant, source: SOURCE, documentId: 'invoice-491', knowledgeObjectId: objectId,
      fields, indexFields: { title: 'Invoice 491', status: 'pending' }, indexRevision: 5,
      connectors: [healthy(sap, { auth: 'degraded', degradedSinceMs: 1000 })], nowMs: 2000,
    });
    expect(res.verdict).toBe('withheld');
    expect(res.composed).toBeNull();       // NOT the stale index 'pending'
    expect(res.withheldConnectors).toBe(1);
  });

  it('(4) auto-resume needs Healthy AND revalidation: rotating still withholds; healthy serves', async () => {
    const sap = new FixtureLivePort({ status: 'approved', revision: 7 });
    // Recovering but revalidation not yet complete → serviceState 'revalidating' → withhold.
    const recovering = await live().livePathQuery({
      tenantId: tenant, source: SOURCE, documentId: 'invoice-491', knowledgeObjectId: objectId,
      fields, indexFields: { title: 'Invoice 491', status: 'pending' }, indexRevision: 5,
      connectors: [healthy(sap, { auth: 'rotating' })], nowMs: 2000,
    });
    expect(recovering.verdict).toBe('withheld');

    // Back to Healthy → serves live again (one revalidation pass modeled by returning to healthy).
    const resumed = await live().livePathQuery({
      tenantId: tenant, source: SOURCE, documentId: 'invoice-491', knowledgeObjectId: objectId,
      fields, indexFields: { title: 'Invoice 491', status: 'pending' }, indexRevision: 7,
      connectors: [healthy(sap, { auth: 'healthy', revalidationComplete: true })],
    });
    expect(resumed.verdict).toBe('served');
    expect(resumed.composed).toEqual({ title: 'Invoice 491', status: 'approved' });
  });

  it('(5) fan-out: top-k ranked; a straggler past the read budget is cut and recorded', async () => {
    const fast = new FixtureLivePort({ status: 'approved', revision: 7 }, 0);
    const slow = new FixtureLivePort({ status: 'approved', revision: 8 }, 200); // exceeds the 50ms budget
    const res = await live().livePathQuery({
      tenantId: tenant, source: SOURCE, documentId: 'invoice-491', knowledgeObjectId: objectId,
      fields, indexFields: { title: 'Invoice 491', status: 'pending' }, indexRevision: 7,
      connectors: [
        healthy(fast, { connectorId: 'sap-fast', healthScore: 0.9 }),
        healthy(slow, { connectorId: 'sap-slow', healthScore: 0.8 }),
      ],
      topK: 2, perReadBudgetMs: 50,
    });
    expect(res.verdict).toBe('served');
    expect(res.stragglerCuts).toContain('sap-slow'); // cut past budget
    expect(res.servedRevision).toBe(7);              // the fast connector's answer won
  });
});
