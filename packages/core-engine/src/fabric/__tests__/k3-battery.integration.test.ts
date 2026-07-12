/**
 * K.3 exit-gate battery (roadmap K.3 ⭐; ADR-003 §7, ADR-010 K.3 arm):
 *   (1) ingest walkthrough: change feed → discovery (events + jobs) →
 *       indexing → 100% of documents metadata-indexed with ACL snapshots
 *       (≥95% gate) + the INV-1 structural-integrity JOIN
 *   (2) permission-filtered query returns cited results for two users
 *       with different access and PROVABLY excludes the unauthorized doc
 *   (3) revocation at the source stops retrieval immediately (live ACL —
 *       within any staleness bound) with read-through + ACLUpdated
 *   (4) §16.2 self-heal: live/index revision conflict → live-validated
 *       serve + ReindexRequested + Knowledge Runtime marks stale
 *   (5) INV-6 replay: duplicate and out-of-order events are no-ops
 *   (6) ADR-010 withholding: degraded connector withholds critical docs
 *       at the storage gate
 *   (7) deletion contract: purge is a tombstone STATE — chunks go,
 *       vector + provenance remain
 *
 * Fixture ports, not @oweibo/connectors (INV-17 — the engine never
 * imports a connector; the drive adapter proves the same contracts in
 * its own package). Skips cleanly without TEST_DATABASE_URL.
 */
import { createHash } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { DiscoveryService, type SyncChangeEvent, type SyncChangeFeedPort } from '../discovery/DiscoveryService';
import { IndexingService, type SyncAclPort, type SyncContentPort } from '../indexing/IndexingService';
import { RetrievalService } from '../retrieval/RetrievalService';
import { JobQueue } from '../scheduler/JobQueue';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

interface FixtureDoc {
  fields: Record<string, unknown>;
  revision: number;
  grants: Array<{ principal: string; kind: 'user' | 'group'; access: string }>;
}

/** A drive-shaped fixture source: change log + content + live ACLs. */
class FixtureSource implements SyncChangeFeedPort<unknown>, SyncContentPort<unknown>, SyncAclPort<unknown> {
  readonly docs = new Map<string, FixtureDoc>();
  private readonly log: SyncChangeEvent[] = [];
  private readonly pageSize = 2;

  put(id: string, fields: Record<string, unknown>, grants: FixtureDoc['grants']): void {
    const prior = this.docs.get(id);
    const revision = (prior?.revision ?? 0) + 1;
    this.docs.set(id, { fields, revision, grants });
    this.log.push({ ref: id, kind: prior ? 'updated' : 'created', sourceRevision: String(revision) });
  }
  setGrants(id: string, grants: FixtureDoc['grants']): void {
    const d = this.docs.get(id)!;
    this.docs.set(id, { ...d, grants });
    // ACL-only change: no content revision bump (drive would bump; the
    // live-ACL path must catch it EVEN without a feed event).
  }
  remove(id: string): void {
    this.docs.delete(id);
    this.log.push({ ref: id, kind: 'deleted', sourceRevision: '0' });
  }
  /** Source moves ahead without a feed event (the §16.2 conflict shape). */
  silentBump(id: string): void {
    const d = this.docs.get(id)!;
    this.docs.set(id, { ...d, revision: d.revision + 1 });
  }

  async listChanges(_ctx: unknown, cursor: string | null) {
    const offset = cursor === null ? 0 : Number(cursor);
    const items = this.log.slice(offset, offset + this.pageSize);
    const next = offset + items.length;
    return { items, nextCursor: String(next) };  // standing tail cursor
  }
  async fetchContent(_ctx: unknown, ref: string) {
    const d = this.docs.get(ref);
    if (!d) throw new Error(`no doc ${ref}`);
    return { fields: d.fields, revision: String(d.revision) };
  }
  async fetchAcl(_ctx: unknown, ref: string) {
    const d = this.docs.get(ref);
    if (!d) throw new Error(`no doc ${ref}`);
    const canon = d.grants.map((g) => `${g.kind}:${g.principal}:${g.access}`).sort().join('\n');
    return {
      aclVersion: `sha256:${createHash('sha256').update(canon).digest('hex')}`,
      principals: d.grants,
    };
  }
}

describeOrSkip('K.3 vertical battery (ADR-003/010 armed)', () => {
  let pool: Pool;
  let tenant: string;
  const CONNECTOR = 'google-drive';
  const SOURCE = 'google_drive';
  const source = new FixtureSource();
  const discovery = () => new DiscoveryService(pool);
  const indexing = () => new IndexingService(pool);
  const retrieval = () => new RetrievalService(pool);
  let cursor: string | null = null;

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
  async function withTenant<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET app.tenant_id = '${tenant}'`);
      return await fn(client);
    } finally {
      await client.query(`RESET app.tenant_id`).catch(() => undefined);
      client.release();
    }
  }

  /** Drain discovery + run every enqueued index job — the K.3 pipeline. */
  async function runPipeline(): Promise<void> {
    const poll = await discovery().poll({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      port: source, ctx: {}, cursor,
    });
    cursor = poll.nextCursor;
    await withTenant(async (c) => {
      const queue = new JobQueue(c);
      for (;;) {
        const jobs = await queue.claim(10);
        if (jobs.length === 0) break;
        for (const job of jobs) {
          const cp = job.checkpoint as { documentId: string; kind: SyncChangeEvent['kind']; sourceRevision: number };
          const result = await indexing().indexDocument({
            tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
            documentId: cp.documentId, sourceRevision: Math.max(cp.sourceRevision, 1),
            kind: cp.kind, content: source, acl: source, ctx: {},
          });
          expect(['indexed', 'purged', 'ignored']).toContain(result.outcome);
          await queue.complete(job.id);
        }
      }
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    tenant = await withPlatformAdmin(async (c) => {
      const r = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas)
         VALUES ('Tenant K3', 'tenant-k3-battery', '{}') RETURNING id`,
      );
      return r.rows[0].id as string;
    });
    // Membership ground truth (K.2 substrate): ada ∈ eng.
    await withTenant((c) =>
      c.query(
        `INSERT INTO oweibo.kf_membership_records (tenant_id, source, principal_ref, group_ref, membership_version)
         VALUES ($1::uuid, $2, 'ada@acme.test', 'eng@acme.test', 1)`,
        [tenant, SOURCE],
      ),
    );
    // The source corpus.
    source.put('doc-plan',
      { title: 'Quarterly roadmap planning', mimeType: 'gdoc', modifiedTime: '2026-07-10T10:00:00Z' },
      [
        { principal: 'ada@acme.test', kind: 'user', access: 'owner' },
        { principal: 'eng@acme.test', kind: 'group', access: 'read' },
      ]);
    source.put('doc-handbook',
      { title: 'Employee handbook onboarding', mimeType: 'pdf', modifiedTime: '2026-07-09T09:00:00Z' },
      [
        { principal: 'ada@acme.test', kind: 'user', access: 'read' },
        { principal: 'bob@acme.test', kind: 'user', access: 'read' },
      ]);
  });

  afterAll(async () => {
    await withPlatformAdmin((c) =>
      c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-k3-battery'`),
    );
    await pool.end();
  });

  it('(1) ingest: discovery → jobs → indexing; 100% indexed with the INV-1 joined shape', async () => {
    await runPipeline();

    const integrity = await withTenant((c) =>
      c.query<{ document_id: string; vectors: string; snaps: string; chunks: string }>(
        `SELECT ko.document_id,
                COUNT(DISTINCT rv.knowledge_object_id)::text AS vectors,
                COUNT(DISTINCT snap.knowledge_object_id)::text AS snaps,
                COUNT(DISTINCT ch.id)::text AS chunks
           FROM oweibo.kf_knowledge_objects ko
           LEFT JOIN oweibo.kf_revision_vectors rv ON rv.knowledge_object_id = ko.id
           LEFT JOIN oweibo.kf_acl_snapshots snap ON snap.knowledge_object_id = ko.id
           LEFT JOIN oweibo.kf_chunks ch ON ch.knowledge_object_id = ko.id
          WHERE ko.tenant_id = $1::uuid AND ko.state = 'indexed'
          GROUP BY ko.document_id ORDER BY ko.document_id`,
        [tenant],
      ).then((r) => r.rows),
    );
    expect(integrity).toHaveLength(2);            // 2/2 = 100% ≥ 95% gate
    for (const row of integrity) {
      expect(row.vectors).toBe('1');              // exactly one vector
      expect(row.snaps).toBe('1');                // exactly one snapshot
      expect(Number(row.chunks)).toBeGreaterThanOrEqual(1);
    }
    // Discovery emitted through the outbox (INV-5 same-txn path).
    const events = await pool.query(
      `SELECT subject FROM oweibo.outbox WHERE payload->>'tenantId' = $1 ORDER BY ts`,
      [tenant],
    );
    expect(events.rows.map((r) => r.subject)).toEqual(
      expect.arrayContaining(['DocumentDiscovered', 'IndexUpdated', 'ACLUpdated']),
    );
  });

  it('(2) two users, different access: cited results; unauthorized doc PROVABLY excluded', async () => {
    const asAda = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'roadmap planning', principalRefs: ['ada@acme.test'],
      acl: source, ctx: {},
    });
    expect(asAda.items.map((i) => i.documentId)).toEqual(['doc-plan']);
    expect(asAda.items[0]!.citation.retrievalId).toBe(asAda.retrievalId);

    // Provenance rows exist for the citation (the substrate GEPA cites).
    const prov = await withTenant((c) =>
      c.query(`SELECT retrieval_path, acl_version FROM oweibo.kf_provenance
                WHERE tenant_id = $1::uuid AND retrieval_id = $2::uuid`,
        [tenant, asAda.retrievalId]),
    );
    expect(prov.rows).toHaveLength(1);

    // Bob has no grant on doc-plan — the same query returns NOTHING.
    const asBob = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'roadmap planning', principalRefs: ['bob@acme.test'],
      acl: source, ctx: {},
    });
    expect(asBob.items).toEqual([]);

    // But bob DOES see what he is granted.
    const bobHandbook = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'handbook onboarding', principalRefs: ['bob@acme.test'],
      acl: source, ctx: {},
    });
    expect(bobHandbook.items.map((i) => i.documentId)).toEqual(['doc-handbook']);
  });

  it('(3) revocation at the source stops retrieval immediately + read-through updates', async () => {
    // Revoke bob on the handbook.
    source.setGrants('doc-handbook', [{ principal: 'ada@acme.test', kind: 'user', access: 'read' }]);

    const afterRevoke = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'handbook onboarding', principalRefs: ['bob@acme.test'],
      acl: source, ctx: {},
    });
    expect(afterRevoke.items).toEqual([]);        // within-bound: instantly

    // Read-through fired: snapshot hash moved + ACLUpdated emitted.
    const snap = await withTenant((c) =>
      c.query<{ acl_version: string }>(
        `SELECT snap.acl_version::text FROM oweibo.kf_acl_snapshots snap
           JOIN oweibo.kf_knowledge_objects ko ON ko.id = snap.knowledge_object_id
          WHERE ko.tenant_id = $1::uuid AND ko.document_id = 'doc-handbook'`,
        [tenant]),
    );
    expect(Number(snap.rows[0]!.acl_version)).toBeGreaterThanOrEqual(2);
  });

  it('(4) §16.2 conflict: live ahead of index → ReindexRequested + stale mark', async () => {
    // Make doc-plan transactional-class so retrieval revision-checks it,
    // then move the source ahead WITHOUT a feed event.
    await withTenant((c) =>
      c.query(
        `UPDATE oweibo.kf_knowledge_objects
            SET freshness_classes = '{"title":"transactional"}'::jsonb
          WHERE tenant_id = $1::uuid AND document_id = 'doc-plan'`,
        [tenant]),
    );
    source.silentBump('doc-plan');

    const r = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'roadmap planning', principalRefs: ['ada@acme.test'],
      acl: source, content: source, ctx: {},
    });
    expect(r.conflictsHealed).toBe(1);
    expect(r.items.map((i) => i.documentId)).toEqual(['doc-plan']);  // user still served

    const reindex = await pool.query(
      `SELECT payload FROM oweibo.outbox
        WHERE subject = 'ReindexRequested' AND payload->>'tenantId' = $1`,
      [tenant],
    );
    expect(reindex.rows).toHaveLength(1);
    expect(reindex.rows[0].payload.conflict).toBe('index_stale');

    // Knowledge Runtime reacts (§3.4): indexed → stale.
    const marked = await indexing().markStale({ tenantId: tenant, connectorId: CONNECTOR, documentId: 'doc-plan' });
    expect(marked.marked).toBe(true);

    // Reindex at the live revision heals: stale → indexed.
    const doc = source.docs.get('doc-plan')!;
    const healed = await indexing().indexDocument({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      documentId: 'doc-plan', sourceRevision: doc.revision, kind: 'updated',
      content: source, acl: source, ctx: {},
    });
    expect(healed.outcome).toBe('indexed');
  });

  it('(5) INV-6 replay: duplicates and out-of-order events are silent no-ops', async () => {
    const doc = source.docs.get('doc-plan')!;
    const dup = await indexing().indexDocument({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      documentId: 'doc-plan', sourceRevision: doc.revision, kind: 'updated',
      content: source, acl: source, ctx: {},
    });
    expect(dup.outcome).toBe('ignored');
    const stale = await indexing().indexDocument({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      documentId: 'doc-plan', sourceRevision: 1, kind: 'updated',
      content: source, acl: source, ctx: {},
    });
    expect(stale.outcome).toBe('ignored');
  });

  it('(6) ADR-010 gate: a degraded connector withholds critical-class docs at the storage layer', async () => {
    await withTenant((c) =>
      c.query(
        `UPDATE oweibo.kf_knowledge_objects
            SET freshness_classes = '{"title":"critical"}'::jsonb
          WHERE tenant_id = $1::uuid AND document_id = 'doc-plan'`,
        [tenant]),
    );
    const r = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'roadmap planning', principalRefs: ['ada@acme.test'],
      acl: source, ctx: {},
      connectorState: 'degraded', degradedSinceMs: Date.now(),
    });
    expect(r.items).toEqual([]);
    expect(r.withheldCount).toBe(1);              // explicit, never silent
  });

  it('(7) deletion contract: purge is a tombstone — chunks go, vector + provenance stay', async () => {
    source.remove('doc-handbook');
    await runPipeline();

    const state = await withTenant((c) =>
      c.query<{ state: string; chunks: string; vectors: string; prov: string }>(
        `SELECT ko.state,
                (SELECT COUNT(*) FROM oweibo.kf_chunks ch WHERE ch.knowledge_object_id = ko.id)::text AS chunks,
                (SELECT COUNT(*) FROM oweibo.kf_revision_vectors rv WHERE rv.knowledge_object_id = ko.id)::text AS vectors,
                (SELECT COUNT(*) FROM oweibo.kf_provenance p WHERE p.knowledge_object_id = ko.id)::text AS prov
           FROM oweibo.kf_knowledge_objects ko
          WHERE ko.tenant_id = $1::uuid AND ko.document_id = 'doc-handbook'`,
        [tenant]),
    );
    expect(state.rows[0]).toMatchObject({ state: 'purged', chunks: '0', vectors: '1' });
    expect(Number(state.rows[0]!.prov)).toBeGreaterThanOrEqual(1);  // citations survive
  });
});
