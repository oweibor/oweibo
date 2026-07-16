/**
 * K.3 — RetrievalService v0: query → ACL check → structural search →
 * provenance/citations (arch §4.3, roadmap K.3).
 *
 * v0 posture (deliberate, ADR-001 refines later):
 *  - Structural search = Postgres FTS over kf_chunks (no embeddings).
 *  - ACL is validated LIVE per candidate through the AclPort — the
 *    Critical-safe default; §6.2's "unchanged version → cached result"
 *    fast path is an ADR-001 optimization this v0 forgoes. The live
 *    result read-through-updates the snapshot (INV-16's single named
 *    exception) and MUST emit ACLUpdated when the hash moved.
 *  - Audience evaluation is within-source (ADR-010 §3.4): the user's
 *    principal ref/email + transitive group closure over
 *    kf_membership_records vs the live grant set.
 *  - Ranking never precedes ACL filtering (INV-2): candidates are
 *    ACL-gated BEFORE the ranked cut is taken.
 *  - Conflict detection (§16.2): for transactional/critical-class docs
 *    the live content revision is compared to the vector entry; a stale
 *    index serves the live-validated result, emits ReindexRequested,
 *    and Knowledge Runtime marks the object stale.
 *  - decideServing (ADR-010 §3.5) gates every result at the storage
 *    layer — a degraded connector's Critical/compliance content is
 *    withheld here, not by planner discretion.
 *  - Every returned object writes ONE kf_provenance row sharing the
 *    retrieval_id (the citation substrate).
 */
import { randomUUID, createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { computeGroupClosure, isInAudience } from '../permissions/groupClosure.js';
import {
  decideServing,
  type ConnectorServingState,
  type FreshnessClass,
} from '../permissions/contract.js';
import { classifyConflict } from '../consistency/contract.js';
import type { SyncAclPort, SyncContentPort } from '../indexing/IndexingService.js';
import { hybridRank, type HybridWeights, type SourceAuthority } from '../semantic/hybridRank.js';
import type { KnowledgeVectorStore } from '../semantic/KnowledgeVectorStore.js';
import type { SemanticCache } from '../semantic/SemanticCache.js';

export interface RetrievalResultItem {
  readonly documentId: string;
  readonly source: string;
  readonly title: string | null;
  readonly snippetField: string;
  readonly rank: number;
  /** Citation substrate: resolve via kf_provenance. */
  readonly citation: {
    readonly retrievalId: string;
    readonly knowledgeObjectId: string;
    readonly sourceRevision: number;
    readonly aclVersion: number;
  };
}

export interface RetrievalResponse {
  readonly retrievalId: string;
  readonly items: readonly RetrievalResultItem[];
  /** Objects withheld by the ADR-010 gate (count only — never silently omitted NOR enumerated). */
  readonly withheldCount: number;
  readonly conflictsHealed: number;
}

export interface RetrieveInput<Ctx> {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly source: string;
  readonly query: string;
  /** The querying user's per-source principal refs (email + ids). */
  readonly principalRefs: readonly string[];
  readonly acl: SyncAclPort<Ctx>;
  /** Needed for §16.2 revision checks on transactional/critical docs. */
  readonly content?: SyncContentPort<Ctx>;
  readonly ctx: Ctx;
  readonly limit?: number;
  /** Lifecycle state of the connector (ADR-004 feeds this; default healthy). */
  readonly connectorState?: ConnectorServingState;
  readonly degradedSinceMs?: number;
  // ── K.5 cache context (optional; needed only when a cache is wired) ──────
  /**
   * Identity + policy version for the ADR-001 §3.6 cache key. `canonicalIdentity`
   * is the ADR-002 canonical id when available; at K.5 the caller passes the
   * per-source principal ref as the provisional stand-in (ADR-001 A2).
   */
  readonly cacheContext?: {
    readonly canonicalIdentity: string;
    readonly policyVersion: string;
  };
  /** Per-connector last-heartbeat timestamps for cache suspension (§7.7). */
  readonly connectorLastHeartbeatMs?: Readonly<Record<string, number>>;
  /** This connector's declared heartbeat interval (§10.1); default 300s. */
  readonly connectorHeartbeatSeconds?: number;
  /**
   * K.8 graph-proximity signal per knowledge_object_id, in [0,1] (ADR-002 §3.6).
   * Absent ⇒ 0 for every candidate; combined with the default hybrid weights
   * (graphProximity weight 0) this is a no-op — a caller arms it by supplying
   * both the map and a hybridWeights with a non-zero graphProximity weight.
   */
  readonly graphProximity?: Readonly<Record<string, number>>;
}

interface Candidate {
  object_id: string;
  document_id: string;
  source: string;
  freshness_classes: Record<string, string>;
  field_name: string;
  content: string;
  rank: number;
  updated_at_ms: string;
  revisions: Record<string, number>;
  index_generation: string;
  acl_version: string;
  permission_hash: string;
}

/**
 * K.5 semantic wiring — all optional. Absent ⇒ RetrievalService behaves
 * exactly as the K.3 FTS-only path (the K.3 battery constructs it with no
 * options and is unaffected).
 */
export interface RetrievalServiceOptions {
  /** When present, vector hits augment FTS candidates and hybrid ranking replaces raw ts_rank. */
  readonly vectorStore?: KnowledgeVectorStore;
  readonly hybridWeights?: HybridWeights;
  readonly sourceAuthority?: SourceAuthority;
  /** When present, the permission-aware result cache is checked and populated (ADR-001 §3.6). */
  readonly cache?: SemanticCache;
}

export class RetrievalService {
  constructor(
    private readonly pool: Pool,
    private readonly opts: RetrievalServiceOptions = {},
  ) {}

  async retrieve<Ctx>(input: RetrieveInput<Ctx>): Promise<RetrievalResponse> {
    const limit = input.limit ?? 10;
    const retrievalId = randomUUID();

    // ── K.5: permission-aware semantic cache pre-check (ADR-001 §3.6). A
    // hit returns immediately; a cross-identity request derives a different
    // key (INV-13) and misses; a suspended connector falls through to a live
    // retrieval (§7.7). Cacheable results are populated at the end. ────────
    const cacheKeyInput = input.cacheContext
      ? {
          tenantId: input.tenantId,
          canonicalIdentity: input.cacheContext.canonicalIdentity,
          policyVersion: input.cacheContext.policyVersion,
          intentEmbeddingRef: intentRef(input.query),
        }
      : null;
    if (this.opts.cache && cacheKeyInput) {
      const hit = this.opts.cache.get(cacheKeyInput, {
        connectorLastHeartbeatMs: input.connectorLastHeartbeatMs ?? {},
      });
      if (hit.status === 'hit') return hit.payload as RetrievalResponse;
      // 'suspended' and 'miss' both fall through to a fresh live retrieval.
    }

    // ── candidates: FTS over indexed objects (over-fetch; ACL cuts) ─────
    const candidates = await this.withTenant(input.tenantId, (c) =>
      c.query<Candidate>(
        `SELECT ko.id AS object_id, ko.document_id, ko.source, ko.freshness_classes,
                ch.field_name, ch.content,
                ts_rank(ch.fts, plainto_tsquery('english', $2)) AS rank,
                (EXTRACT(EPOCH FROM ko.updated_at) * 1000)::bigint::text AS updated_at_ms,
                rv.revisions, rv.index_generation::text,
                snap.acl_version::text, snap.permission_hash
           FROM oweibo.kf_chunks ch
           JOIN oweibo.kf_knowledge_objects ko ON ko.id = ch.knowledge_object_id
           JOIN oweibo.kf_revision_vectors rv ON rv.knowledge_object_id = ko.id
           JOIN oweibo.kf_acl_snapshots snap ON snap.knowledge_object_id = ko.id
          WHERE ko.tenant_id = $1::uuid
            AND ko.state = 'indexed'
            AND ko.connector_id = $3
            AND ch.fts @@ plainto_tsquery('english', $2)
          ORDER BY rank DESC
          LIMIT $4`,
        [input.tenantId, input.query, input.connectorId, limit * 5],
      ).then((r) => r.rows),
    );

    // ── K.5: semantic augmentation (opt-in). Vector search surfaces docs
    // lexical FTS missed; hits are keyed by object → per-object cosine. ──
    const vectorScores = new Map<string, number>();
    if (this.opts.vectorStore) {
      const hits = await this.opts.vectorStore.search(input.tenantId, input.query, limit * 5);
      for (const h of hits) {
        vectorScores.set(h.knowledgeObjectId, Math.max(vectorScores.get(h.knowledgeObjectId) ?? 0, h.score));
      }
      const known = new Set(candidates.map((c) => c.object_id));
      const missingIds = [...vectorScores.keys()].filter((id) => !known.has(id));
      if (missingIds.length > 0) {
        candidates.push(...(await this.fetchCandidatesByIds(input.tenantId, input.connectorId, missingIds)));
      }
    }

    if (candidates.length === 0) {
      return { retrievalId, items: [], withheldCount: 0, conflictsHealed: 0 };
    }

    // Group closure once per query (within-source, ADR-010 §3.3/§3.4).
    const edges = await this.withTenant(input.tenantId, (c) =>
      c.query<{ principal_ref: string; group_ref: string }>(
        `SELECT principal_ref, group_ref FROM oweibo.kf_membership_records
          WHERE tenant_id = $1::uuid`,
        [input.tenantId],
      ).then((r) => r.rows.map((e) => ({ principalRef: e.principal_ref, groupRef: e.group_ref }))),
    );

    // ── per-object gate: serving decision + LIVE ACL + §16.2 check ──────
    const byObject = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const list = byObject.get(c.object_id);
      if (list) list.push(c);
      else byObject.set(c.object_id, [c]);
    }

    // Each surviving object carries its ranking signals so the ranked cut
    // (below) can be raw ts_rank (K.3) or the K.5 hybrid fusion.
    const scored: Array<{
      item: RetrievalResultItem;
      lexical: number;
      vector: number;
      updatedAtMs: number;
      source: string;
      /** Group-kind grants on this doc — the MembershipChanged invalidation keys (§7.7). */
      groupRefs: readonly string[];
      freshnessClass: FreshnessClass;
    }> = [];
    let withheldCount = 0;
    let conflictsHealed = 0;

    for (const [objectId, chunks] of byObject) {
      const doc = chunks[0]!;
      const docClass = worstClass(doc.freshness_classes);

      // Storage-layer serving gate (ADR-010 §3.5) — NEVER planner logic.
      const decision = decideServing({
        freshnessClass: docClass,
        complianceFlagged: false,   // ADR-006 wiring lands with policy work
        connectorState: input.connectorState ?? 'healthy',
        ...(input.degradedSinceMs !== undefined ? { degradedSinceMs: input.degradedSinceMs } : {}),
        nowMs: Date.now(),
      });
      if (decision === 'withhold') {
        withheldCount += 1;
        continue;
      }

      // LIVE ACL (v0 always-live; Critical-safe).
      let live: Awaited<ReturnType<SyncAclPort<Ctx>['fetchAcl']>>;
      try {
        live = await input.acl.fetchAcl(input.ctx, doc.document_id);
      } catch {
        // Cannot verify → fail closed for this object (§6.4 posture).
        withheldCount += 1;
        continue;
      }

      // Read-through (INV-16 exception): hash moved → snapshot update +
      // ACLUpdated, inside one txn.
      let aclVersion = Number(doc.acl_version);
      if (live.aclVersion !== doc.permission_hash) {
        aclVersion += 1;
        await this.withTenant(input.tenantId, async (c) => {
          await c.query(
            `UPDATE oweibo.kf_acl_snapshots
                SET acl_version = $2, permission_hash = $3, last_checked = NOW()
              WHERE knowledge_object_id = $1::uuid`,
            [objectId, aclVersion, live.aclVersion],
          );
          await c.query(
            `INSERT INTO oweibo.outbox (subject, payload) VALUES ('ACLUpdated', $1::jsonb)`,
            [JSON.stringify({
              tenantId: input.tenantId, source: doc.source, document_id: doc.document_id,
              acl_version: aclVersion, timestamp: new Date().toISOString(),
            })],
          );
        });
      }

      // Audience evaluation (INV-2: before ranking cut).
      const grants = new Set(live.principals.map((p) => p.principal));
      const inAudience = input.principalRefs.some((ref) => {
        const closure = computeGroupClosure(edges, ref);
        if (closure.truncated) return false;  // truncated → this live check already IS the fallback; deny unless direct
        return isInAudience(grants, ref, closure);
      }) || input.principalRefs.some((ref) => grants.has(ref));
      if (!inAudience) continue;              // exclusion, not withholding

      // §16.2 conflict check for transactional/critical docs.
      const storedRevision = doc.revisions[doc.source] ?? 0;
      if (input.content && (docClass === 'transactional' || docClass === 'critical')) {
        try {
          const liveContent = await input.content.fetchContent(input.ctx, doc.document_id);
          const cls = classifyConflict(Number(liveContent.revision), storedRevision);
          if (cls !== 'consistent') {
            conflictsHealed += 1;
            await this.withTenant(input.tenantId, (c) =>
              c.query(
                `INSERT INTO oweibo.outbox (subject, payload) VALUES ('ReindexRequested', $1::jsonb)`,
                [JSON.stringify({
                  tenantId: input.tenantId, source: doc.source, document_id: doc.document_id,
                  live_revision: Number(liveContent.revision), index_revision: storedRevision,
                  conflict: cls, timestamp: new Date().toISOString(),
                })],
              ),
            );
          }
        } catch { /* live probe failure never blocks an index-served class */ }
      }

      const best = chunks.reduce((a, b) => (a.rank >= b.rank ? a : b));
      scored.push({
        item: {
          documentId: doc.document_id,
          source: doc.source,
          title: titleOf(chunks),
          snippetField: best.field_name,
          rank: Number(best.rank),
          citation: {
            retrievalId,
            knowledgeObjectId: objectId,
            sourceRevision: storedRevision,
            aclVersion,
          },
        },
        lexical: Number(best.rank),
        vector: vectorScores.get(objectId) ?? 0,
        updatedAtMs: Number(doc.updated_at_ms) || Date.now(),
        source: doc.source,
        groupRefs: live.principals.filter((p) => p.kind === 'group').map((p) => p.principal),
        freshnessClass: docClass,
      });
    }

    // ── ranked cut — STRICTLY after ACL filtering (INV-2). Hybrid fusion
    // when the semantic layer is wired; raw ts_rank otherwise (K.3). ──────
    let ordered: RetrievalResultItem[];
    if (this.opts.vectorStore) {
      const ranked = hybridRank(
        scored.map((s) => ({
          candidateId: s.item.citation.knowledgeObjectId,
          lexical: s.lexical,
          vector: s.vector,
          updatedAtMs: s.updatedAtMs,
          source: s.source,
          graphProximity: input.graphProximity?.[s.item.citation.knowledgeObjectId] ?? 0,
        })),
        {
          ...(this.opts.hybridWeights ? { weights: this.opts.hybridWeights } : {}),
          ...(this.opts.sourceAuthority ? { sourceAuthority: this.opts.sourceAuthority } : {}),
        },
      );
      const byId = new Map(scored.map((s) => [s.item.citation.knowledgeObjectId, s.item]));
      ordered = ranked.map((r) => ({ ...byId.get(r.candidateId)!, rank: r.score }));
    } else {
      ordered = scored.sort((a, b) => b.item.rank - a.item.rank).map((s) => s.item);
    }
    const top = ordered.slice(0, limit);

    // Provenance: one row per returned object, shared retrieval_id.
    if (top.length > 0) {
      await this.withTenant(input.tenantId, async (c) => {
        for (const item of top) {
          const doc = byObject.get(item.citation.knowledgeObjectId)![0]!;
          await c.query(
            `INSERT INTO oweibo.kf_provenance
               (tenant_id, retrieval_id, knowledge_object_id, source, retrieval_path,
                index_generation, source_revision, acl_version, freshness_class)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'hybrid', $5, $6, $7, $8)`,
            [
              input.tenantId, retrievalId, item.citation.knowledgeObjectId, item.source,
              Number(doc.index_generation), item.citation.sourceRevision,
              item.citation.aclVersion, worstClass(doc.freshness_classes),
            ],
          );
        }
      });
    }

    const response: RetrievalResponse = { retrievalId, items: top, withheldCount, conflictsHealed };

    // ── K.5: populate the cache. `put` refuses Critical by contract (INV-3),
    // so a Critical result is never written even if a caller forgets. ──────
    if (this.opts.cache && cacheKeyInput && top.length > 0) {
      const topEntries = top.map((t) =>
        scored.find((s) => s.item.citation.knowledgeObjectId === t.citation.knowledgeObjectId)!,
      );
      const strictest = strictestClass(topEntries.map((s) => s.freshnessClass));
      this.opts.cache.put({
        keyInput: cacheKeyInput,
        payload: response,
        strictestClass: strictest,
        contributingDocumentIds: top.map((t) => t.documentId),
        contributingGroupRefs: [...new Set(topEntries.flatMap((s) => s.groupRefs))],
        contributingConnectors: [
          { connectorId: input.connectorId, heartbeatSeconds: input.connectorHeartbeatSeconds ?? 300 },
        ],
      });
    }

    return response;
  }

  /** Fetch candidate rows for objects surfaced by vector search but missed by FTS. */
  private async fetchCandidatesByIds(
    tenantId: string,
    connectorId: string,
    objectIds: readonly string[],
  ): Promise<Candidate[]> {
    if (objectIds.length === 0) return [];
    return this.withTenant(tenantId, (c) =>
      c.query<Candidate>(
        `SELECT ko.id AS object_id, ko.document_id, ko.source, ko.freshness_classes,
                ch.field_name, ch.content,
                0::real AS rank,
                (EXTRACT(EPOCH FROM ko.updated_at) * 1000)::bigint::text AS updated_at_ms,
                rv.revisions, rv.index_generation::text,
                snap.acl_version::text, snap.permission_hash
           FROM oweibo.kf_chunks ch
           JOIN oweibo.kf_knowledge_objects ko ON ko.id = ch.knowledge_object_id
           JOIN oweibo.kf_revision_vectors rv ON rv.knowledge_object_id = ko.id
           JOIN oweibo.kf_acl_snapshots snap ON snap.knowledge_object_id = ko.id
          WHERE ko.tenant_id = $1::uuid
            AND ko.state = 'indexed'
            AND ko.connector_id = $2
            AND ko.id = ANY($3::uuid[])`,
        [tenantId, connectorId, [...objectIds]],
      ).then((r) => r.rows),
    );
  }

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
}

const CLASS_ORDER: FreshnessClass[] = ['static', 'operational', 'transactional', 'critical'];

function worstClass(classes: Record<string, string>): FreshnessClass {
  let worst: FreshnessClass = 'static';
  for (const v of Object.values(classes)) {
    const idx = CLASS_ORDER.indexOf(v as FreshnessClass);
    if (idx > CLASS_ORDER.indexOf(worst)) worst = v as FreshnessClass;
  }
  return worst;
}

function titleOf(chunks: readonly Candidate[]): string | null {
  return chunks.find((c) => c.field_name === 'title')?.content ?? null;
}

/** Strictest (worst) class across a set — sets the cache TTL + cacheability. */
function strictestClass(classes: readonly FreshnessClass[]): FreshnessClass {
  let worst: FreshnessClass = 'static';
  for (const v of classes) {
    if (CLASS_ORDER.indexOf(v) > CLASS_ORDER.indexOf(worst)) worst = v;
  }
  return worst;
}

/**
 * A stable reference for the query's intent embedding, used in the cache key
 * (ADR-001 §3.6). At K.5 this is a hash of the normalized query text; when the
 * semantic cache matches by embedding similarity (its full §7.7 form), this
 * becomes the embedding's bucket id. The identity component of the key — the
 * INV-13 guarantee — is separate and always present.
 */
function intentRef(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase()).digest('hex').slice(0, 32);
}
