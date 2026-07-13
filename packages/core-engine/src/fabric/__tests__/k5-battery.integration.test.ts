/**
 * K.5 exit-gate battery (roadmap K.5; ADR-001 §3.6 armed). Against live
 * Postgres, with a DETERMINISTIC in-memory Qdrant + a concept embedder
 * (CI-safe — the real Ollama/Qdrant is the unexercised half, like the
 * live-Google connectors). Gates:
 *   (1) semantic recall ≥ target on a seeded query set — INCLUDING a query
 *       with no lexical overlap that FTS alone misses but the vector path
 *       surfaces ("vacation days" → the PTO doc);
 *   (2) cache correctness through the live retrieve() path: same identity
 *       hits; a cross-identity request MISSES by key derivation (INV-13);
 *   (3) event invalidation forces a recompute;
 *   (4) heartbeat-silence suspension forces a recompute (§7.7);
 *   (5) chunk-diff re-embedding: a one-field update re-embeds ONE chunk;
 *   (6) Indexing Scope: a metadata-only tenant skips embedding entirely.
 *
 * Skips cleanly without TEST_DATABASE_URL. Fixture ports, not
 * @oweibo/connectors (INV-17).
 */
import { createHash } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { DiscoveryService, type SyncChangeEvent, type SyncChangeFeedPort } from '../discovery/DiscoveryService';
import { IndexingService, type SyncAclPort, type SyncContentPort } from '../indexing/IndexingService';
import { RetrievalService } from '../retrieval/RetrievalService';
import { JobQueue } from '../scheduler/JobQueue';
import { KnowledgeVectorStore } from '../semantic/KnowledgeVectorStore';
import { ChunkEmbeddingIndexer } from '../semantic/ChunkEmbeddingIndexer';
import { SemanticCache } from '../semantic/SemanticCache';
import { cosineSimilarity } from '../semantic/vectorMath';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

// ── Concept embedder: maps synonymous words to shared concept dims, so
// "vacation" and "PTO" land near each other even with zero lexical overlap. ─
const CONCEPTS: Record<string, readonly string[]> = {
  timeoff: ['pto', 'vacation', 'leave', 'holiday', 'paid', 'time', 'off', 'days'],
  roadmap: ['roadmap', 'planning', 'quarterly', 'plan', 'design', 'docs'],
  security: ['security', 'auth', 'vulnerability', 'incident', 'breach'],
  finance: ['invoice', 'payment', 'approved', 'finance', 'budget'],
};
const CONCEPT_KEYS = Object.keys(CONCEPTS);

function conceptEmbed(text: string): number[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const v = CONCEPT_KEYS.map((k) => tokens.filter((t) => CONCEPTS[k]!.includes(t)).length);
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  // Pad to a stable dimension so the store's auto-create is consistent.
  const padded = [...v.map((x) => x / norm)];
  while (padded.length < 8) padded.push(0);
  return padded;
}

// ── Minimal in-memory Qdrant honoring the client surface the store uses. ────
class FakeQdrant {
  private readonly collections = new Map<string, Map<string, { vector: number[]; payload: Record<string, unknown> }>>();
  async getCollection(name: string) {
    if (!this.collections.has(name)) throw new Error(`no collection ${name}`);
    return { points_count: this.collections.get(name)!.size };
  }
  async createCollection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
  }
  async upsert(name: string, { points }: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }) {
    const col = this.collections.get(name) ?? new Map();
    this.collections.set(name, col);
    for (const p of points) col.set(p.id, { vector: p.vector, payload: p.payload });
  }
  async delete(name: string, arg: { points?: string[]; filter?: { must: Array<{ key: string; match: { value: unknown } }> } }) {
    const col = this.collections.get(name);
    if (!col) return;
    if (arg.points) { for (const id of arg.points) col.delete(id); return; }
    if (arg.filter) {
      for (const [id, pt] of col) {
        if (arg.filter.must.every((m) => pt.payload[m.key] === m.match.value)) col.delete(id);
      }
    }
  }
  async search(name: string, arg: { vector: number[]; limit: number; filter?: { must: Array<{ key: string; match: { value: unknown } }> } }) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`no collection ${name}`);
    const must = arg.filter?.must ?? [];
    return [...col.values()]
      .filter((pt) => must.every((m) => pt.payload[m.key] === m.match.value))
      .map((pt) => ({ score: cosineSimilarity(arg.vector, pt.vector), payload: pt.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, arg.limit);
  }
}

interface FixtureDoc {
  fields: Record<string, unknown>;
  revision: number;
  grants: Array<{ principal: string; kind: 'user' | 'group'; access: string }>;
}
class FixtureSource implements SyncChangeFeedPort<unknown>, SyncContentPort<unknown>, SyncAclPort<unknown> {
  readonly docs = new Map<string, FixtureDoc>();
  private readonly log: SyncChangeEvent[] = [];
  put(id: string, fields: Record<string, unknown>, grants: FixtureDoc['grants']): void {
    const prior = this.docs.get(id);
    const revision = (prior?.revision ?? 0) + 1;
    this.docs.set(id, { fields, revision, grants });
    this.log.push({ ref: id, kind: prior ? 'updated' : 'created', sourceRevision: String(revision) });
  }
  async listChanges(_ctx: unknown, cursor: string | null) {
    const offset = cursor === null ? 0 : Number(cursor);
    const items = this.log.slice(offset, offset + 10);
    return { items, nextCursor: String(offset + items.length) };
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
    return { aclVersion: `sha256:${createHash('sha256').update(canon).digest('hex')}`, principals: d.grants };
  }
}

describeOrSkip('K.5 semantic battery (ADR-001 §3.6 armed)', () => {
  let pool: Pool;
  let tenant: string;
  const CONNECTOR = 'google-drive';
  const SOURCE = 'google_drive';
  const source = new FixtureSource();
  const qdrant = new FakeQdrant();
  const embedder = (t: string) => Promise.resolve(conceptEmbed(t));
  const vectorStore = new KnowledgeVectorStore(qdrant, embedder, { vectorDimension: 8 });
  const embeddingIndexer = new ChunkEmbeddingIndexer(vectorStore);
  const cache = new SemanticCache();
  let cursor: string | null = null;

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

  /** Discovery → index → embed the changed chunks (full_content scope). */
  async function runPipeline(scope: 'metadata' | 'full_content' = 'full_content'): Promise<number> {
    const poll = await new DiscoveryService(pool).poll({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, port: source, ctx: {}, cursor,
    });
    cursor = poll.nextCursor;
    let embedded = 0;
    await withTenant(async (c) => {
      const queue = new JobQueue(c);
      for (;;) {
        const jobs = await queue.claim(10);
        if (jobs.length === 0) break;
        for (const job of jobs) {
          const cp = job.checkpoint as { documentId: string; kind: SyncChangeEvent['kind']; sourceRevision: number };
          const res = await new IndexingService(pool).indexDocument({
            tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
            documentId: cp.documentId, sourceRevision: Math.max(cp.sourceRevision, 1),
            kind: cp.kind, content: source, acl: source, ctx: {},
          });
          if (res.outcome === 'indexed' && res.knowledgeObjectId) {
            const r = await embeddingIndexer.applyDiff({
              tenantId: tenant, knowledgeObjectId: res.knowledgeObjectId,
              documentId: cp.documentId, source: SOURCE, sourceRevision: Math.max(cp.sourceRevision, 1),
              changedChunks: res.changedChunks ?? [], deletedChunks: res.deletedChunks ?? [], scope,
            });
            embedded += r.embedded;
          }
          await queue.complete(job.id);
        }
      }
    });
    return embedded;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    tenant = await withPlatformAdmin(async (c) => {
      const r = await c.query(
        `INSERT INTO oweibo.tenants (name, slug, quotas) VALUES ('Tenant K5', 'tenant-k5-battery', '{}') RETURNING id`,
      );
      return r.rows[0].id as string;
    });
    // Everyone in eng; ada + bob are members. doc-pto is granted to eng.
    await withTenant((c) =>
      c.query(
        `INSERT INTO oweibo.kf_membership_records (tenant_id, source, principal_ref, group_ref, membership_version)
         VALUES ($1::uuid,$2,'ada@acme.test','eng@acme.test',1), ($1::uuid,$2,'bob@acme.test','eng@acme.test',1)`,
        [tenant, SOURCE],
      ),
    );
    source.put('doc-pto',
      { title: 'PTO paid time off', body: 'Employees accrue paid leave and holiday days each quarter.' },
      [{ principal: 'eng@acme.test', kind: 'group', access: 'read' }]);
    source.put('doc-roadmap',
      { title: 'Quarterly roadmap planning', body: 'The design docs for the quarterly product plan.' },
      [{ principal: 'ada@acme.test', kind: 'user', access: 'owner' }]);
    const embedded = await runPipeline('full_content');
    expect(embedded).toBeGreaterThanOrEqual(2); // both docs' chunks embedded
  });

  afterAll(async () => {
    await withPlatformAdmin((c) => c.query(`DELETE FROM oweibo.tenants WHERE slug = 'tenant-k5-battery'`));
    await pool.end();
  });

  const retrieval = () => new RetrievalService(pool, { vectorStore, cache });

  it('(1) semantic recall: "vacation days" surfaces the PTO doc that FTS alone misses', async () => {
    // Sanity: pure FTS (no vector store) does NOT match "vacation" to "PTO".
    const ftsOnly = await new RetrievalService(pool).retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'vacation days', principalRefs: ['ada@acme.test'], acl: source, ctx: {},
    });
    expect(ftsOnly.items.map((i) => i.documentId)).not.toContain('doc-pto');

    // Hybrid (vector) path surfaces it via the concept embedding.
    const hybrid = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE,
      query: 'vacation days', principalRefs: ['ada@acme.test'], acl: source, ctx: {},
    });
    expect(hybrid.items.map((i) => i.documentId)).toContain('doc-pto');
  });

  it('(2) cache: same identity hits (identical retrievalId); a cross-identity request misses (INV-13)', async () => {
    const ctxAda = { cacheContext: { canonicalIdentity: 'ada@acme.test', policyVersion: 'v1' }, connectorLastHeartbeatMs: { [CONNECTOR]: Date.now() } };
    const first = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, query: 'roadmap planning',
      principalRefs: ['ada@acme.test'], acl: source, ctx: {}, ...ctxAda,
    });
    expect(first.items.map((i) => i.documentId)).toContain('doc-roadmap');

    const second = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, query: 'roadmap planning',
      principalRefs: ['ada@acme.test'], acl: source, ctx: {}, ...ctxAda,
    });
    expect(second.retrievalId).toBe(first.retrievalId); // served from cache

    // Bob: different canonical identity → different key → NOT ada's entry.
    const bob = await retrieval().retrieve({
      tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, query: 'roadmap planning',
      principalRefs: ['bob@acme.test'], acl: source, ctx: {},
      cacheContext: { canonicalIdentity: 'bob@acme.test', policyVersion: 'v1' },
      connectorLastHeartbeatMs: { [CONNECTOR]: Date.now() },
    });
    expect(bob.retrievalId).not.toBe(first.retrievalId);
    // Bob has no grant on doc-roadmap (ada-owned) → provably excluded.
    expect(bob.items.map((i) => i.documentId)).not.toContain('doc-roadmap');
  });

  it('(3) invalidation: ACLUpdated on a contributing doc forces a recompute', async () => {
    const q = { tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, query: 'paid leave holiday',
      principalRefs: ['ada@acme.test'], acl: source, ctx: {},
      cacheContext: { canonicalIdentity: 'ada@acme.test', policyVersion: 'v1' },
      connectorLastHeartbeatMs: { [CONNECTOR]: Date.now() } };
    const first = await retrieval().retrieve(q);
    expect(first.items.map((i) => i.documentId)).toContain('doc-pto');
    cache.invalidate({ subject: 'ACLUpdated', documentId: 'doc-pto' });
    const after = await retrieval().retrieve(q);
    expect(after.retrievalId).not.toBe(first.retrievalId); // recomputed, not cached
  });

  it('(4) heartbeat silence suspends the cached entry → recompute (§7.7)', async () => {
    const base = { tenantId: tenant, connectorId: CONNECTOR, source: SOURCE, query: 'design docs plan',
      principalRefs: ['ada@acme.test'], acl: source, ctx: {},
      cacheContext: { canonicalIdentity: 'ada@acme.test', policyVersion: 'v1' } };
    const first = await retrieval().retrieve({ ...base, connectorLastHeartbeatMs: { [CONNECTOR]: Date.now() } });
    // Now the connector has been silent for an hour (> 300s heartbeat).
    const suspended = await retrieval().retrieve({ ...base, connectorLastHeartbeatMs: { [CONNECTOR]: Date.now() - 3_600_000 } });
    expect(suspended.retrievalId).not.toBe(first.retrievalId); // not served from cache
  });

  it('(5) chunk-diff re-embedding: a one-field update re-embeds exactly one chunk', async () => {
    // Change only the body of doc-roadmap; the title chunk is unchanged.
    source.put('doc-roadmap',
      { title: 'Quarterly roadmap planning', body: 'Updated: the quarterly plan now covers security incident response.' },
      [{ principal: 'ada@acme.test', kind: 'user', access: 'owner' }]);
    const embedded = await runPipeline('full_content');
    expect(embedded).toBe(1); // only the changed body chunk re-embedded
  });

  it('(6) Indexing Scope: a metadata-only tenant skips embedding entirely', async () => {
    source.put('doc-sec',
      { title: 'Security incident runbook', body: 'Auth breach response.' },
      [{ principal: 'ada@acme.test', kind: 'user', access: 'read' }]);
    const embedded = await runPipeline('metadata');
    expect(embedded).toBe(0); // scope gate skipped the embed
  });
});
