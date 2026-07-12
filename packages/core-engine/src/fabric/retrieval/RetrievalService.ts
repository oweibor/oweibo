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
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { computeGroupClosure, isInAudience } from '../permissions/groupClosure.js';
import {
  decideServing,
  type ConnectorServingState,
  type FreshnessClass,
} from '../permissions/contract.js';
import { classifyConflict } from '../consistency/contract.js';
import type { SyncAclPort, SyncContentPort } from '../indexing/IndexingService.js';

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
}

interface Candidate {
  object_id: string;
  document_id: string;
  source: string;
  freshness_classes: Record<string, string>;
  field_name: string;
  content: string;
  rank: number;
  revisions: Record<string, number>;
  index_generation: string;
  acl_version: string;
  permission_hash: string;
}

export class RetrievalService {
  constructor(private readonly pool: Pool) {}

  async retrieve<Ctx>(input: RetrieveInput<Ctx>): Promise<RetrievalResponse> {
    const limit = input.limit ?? 10;
    const retrievalId = randomUUID();

    // ── candidates: FTS over indexed objects (over-fetch; ACL cuts) ─────
    const candidates = await this.withTenant(input.tenantId, (c) =>
      c.query<Candidate>(
        `SELECT ko.id AS object_id, ko.document_id, ko.source, ko.freshness_classes,
                ch.field_name, ch.content,
                ts_rank(ch.fts, plainto_tsquery('english', $2)) AS rank,
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

    const items: RetrievalResultItem[] = [];
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
      items.push({
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
      });
    }

    items.sort((a, b) => b.rank - a.rank);
    const top = items.slice(0, limit);

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

    return { retrievalId, items: top, withheldCount, conflictsHealed };
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
