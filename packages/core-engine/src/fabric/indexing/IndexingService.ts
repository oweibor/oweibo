/**
 * K.3 — IndexingService: Knowledge Runtime's sole-writer path for the
 * knowledge stores (INV-16). Processes one document per call:
 *
 *   1. §14.3 comparison against the stored revision vector — `ignore`
 *      is a silent no-op (INV-6); a gap enqueues class-3 backfill.
 *   2. Fetch content + ACL through the ports (outside the txn).
 *   3. One transaction: object upsert (state transition per ADR-003
 *      §3.4), chunk-diff writes (§3.5 — unchanged chunks untouched),
 *      monotonic vector merge (§3.2 — a decrease dead-letters), ACL
 *      snapshot upsert (platform-side acl_version counter bumps when
 *      the §6.2 grant hash changes), plus IndexUpdated / ACLUpdated
 *      into the outbox — INV-5 by construction.
 *
 * Deletion (§3.4): 'purged' is a STATE — chunks deleted, object row +
 * revision vector + provenance REMAIN as the tombstone.
 *
 * Grant storage note (§6.2): the snapshot table stores version + hash
 * ONLY. The grant set needed for audience evaluation is fetched live by
 * Retrieval (v0 always-live posture — Critical-safe; index-path grant
 * caching is ADR-001 optimization territory).
 */
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { JobQueue } from '../scheduler/index.js';
import {
  compareRevisions,
  gapRange,
  mergeRevisionVector,
  chunksToReindex,
  type RevisionMap,
} from '../consistency/contract.js';

// Structural mirrors of the SDK port surfaces (engine takes no
// connector-sdk dependency; see MembershipSyncService rationale).
export interface SyncContentPort<Ctx> {
  fetchContent(ctx: Ctx, ref: string): Promise<{
    readonly fields: Readonly<Record<string, unknown>>;
    readonly revision: string;
  }>;
}
export interface SyncAclPort<Ctx> {
  fetchAcl(ctx: Ctx, ref: string): Promise<{
    readonly aclVersion: string;   // the §6.2 grant hash from the adapter
    readonly principals: ReadonlyArray<{ principal: string; kind: 'user' | 'group'; access: string }>;
  }>;
}

export interface IndexDocumentInput<Ctx> {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly source: string;
  readonly documentId: string;
  readonly sourceRevision: number;
  readonly kind: 'created' | 'updated' | 'deleted' | 'acl_changed';
  readonly content?: SyncContentPort<Ctx>;
  readonly acl?: SyncAclPort<Ctx>;
  readonly ctx: Ctx;
  /** Field → freshness class; defaults to operational per field. */
  readonly freshnessClasses?: Readonly<Record<string, string>>;
}

export type IndexOutcome = 'indexed' | 'purged' | 'ignored' | 'dead_lettered';

/** A chunk's identity + content, surfaced so the K.5 embedding layer re-embeds ONLY what changed. */
export interface ChangedChunk {
  readonly fieldName: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly freshnessClass: string;
  readonly content: string;
}

export interface IndexDocumentResult {
  readonly outcome: IndexOutcome;
  readonly knowledgeObjectId?: string;
  readonly chunksUpserted?: number;
  readonly chunksDeleted?: number;
  readonly backfillEnqueued?: boolean;
  readonly aclVersionBumped?: boolean;
  /** Chunk-diff (§3.5): the chunks whose content changed — the K.5 re-embed set. */
  readonly changedChunks?: readonly ChangedChunk[];
  /** Chunk identities removed this update — their vectors must be dropped. */
  readonly deletedChunks?: readonly Omit<ChangedChunk, 'content'>[];
  readonly detail?: string;
}

export class IndexingService {
  constructor(private readonly pool: Pool) {}

  async indexDocument<Ctx>(input: IndexDocumentInput<Ctx>): Promise<IndexDocumentResult> {
    if (input.kind === 'deleted') return this.purge(input);

    // ── 1. comparison rule, read-only pre-check ──────────────────────────
    const pre = await this.withTenant(input.tenantId, async (c) => {
      const obj = await c.query<{ id: string }>(
        `SELECT id FROM oweibo.kf_knowledge_objects
          WHERE tenant_id = $1::uuid AND connector_id = $2 AND document_id = $3`,
        [input.tenantId, input.connectorId, input.documentId],
      );
      const objectId = obj.rows[0]?.id;
      if (!objectId) return { stored: undefined as number | undefined, objectId: undefined };
      const vec = await c.query<{ revisions: RevisionMap; index_generation: string }>(
        `SELECT revisions, index_generation::text FROM oweibo.kf_revision_vectors
          WHERE knowledge_object_id = $1::uuid`,
        [objectId],
      );
      return {
        stored: vec.rows[0]?.revisions?.[input.source],
        objectId,
      };
    });

    const verdict = compareRevisions(input.sourceRevision, pre.stored);
    if (verdict === 'ignore') return { outcome: 'ignored' };

    // ── 2. port fetches, outside the transaction ─────────────────────────
    if (!input.content || !input.acl) {
      throw new Error('IndexingService: content and acl ports are required for index writes');
    }
    const contentResult = await input.content.fetchContent(input.ctx, input.documentId);
    const aclResult = await input.acl.fetchAcl(input.ctx, input.documentId);

    // ── 3. the sole-writer transaction ───────────────────────────────────
    return this.withTenant(input.tenantId, async (c) => {
      // Object upsert (state → indexed; §3.4 transitions).
      const obj = await c.query<{ id: string }>(
        `INSERT INTO oweibo.kf_knowledge_objects
           (tenant_id, connector_id, source, document_id, indexing_depth, freshness_classes, state, updated_at)
         VALUES ($1::uuid, $2, $3, $4, 'metadata', $5::jsonb, 'indexed', NOW())
         ON CONFLICT ON CONSTRAINT kf_knowledge_objects_unique_doc
         DO UPDATE SET state = 'indexed', freshness_classes = EXCLUDED.freshness_classes, updated_at = NOW()
         RETURNING id`,
        [
          input.tenantId, input.connectorId, input.source, input.documentId,
          JSON.stringify(input.freshnessClasses ?? defaultClasses(contentResult.fields)),
        ],
      );
      const objectId = obj.rows[0]!.id;

      // Vector: monotonic merge; a decrease dead-letters the event.
      const vecRow = await c.query<{ revisions: RevisionMap; index_generation: string }>(
        `SELECT revisions, index_generation::text FROM oweibo.kf_revision_vectors
          WHERE knowledge_object_id = $1::uuid FOR UPDATE`,
        [objectId],
      );
      const current = vecRow.rows[0] ?? { revisions: {}, index_generation: '0' };
      const merged = mergeRevisionVector({
        revisions: current.revisions,
        indexGeneration: Number(current.index_generation),
        source: input.source,
        incomingRevision: input.sourceRevision,
      });
      if (!merged.ok) {
        await c.query(
          `INSERT INTO oweibo.outbox (subject, payload) VALUES ('IndexDeadLetter', $1::jsonb)`,
          [JSON.stringify({ tenantId: input.tenantId, document_id: input.documentId, source: input.source, violation: merged.violation })],
        );
        return { outcome: 'dead_lettered' as const, detail: merged.violation };
      }
      await c.query(
        `INSERT INTO oweibo.kf_revision_vectors (knowledge_object_id, tenant_id, revisions, index_generation, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, NOW())
         ON CONFLICT (knowledge_object_id)
         DO UPDATE SET revisions = EXCLUDED.revisions, index_generation = EXCLUDED.index_generation, updated_at = NOW()`,
        [objectId, input.tenantId, JSON.stringify(merged.revisions), merged.indexGeneration],
      );

      // Chunk-diff (§3.5): one chunk per field at metadata depth.
      const incoming = chunkFields(contentResult.fields, input.freshnessClasses);
      const storedChunks = await c.query<{
        id: string; field_name: string; span_start: number; span_end: number; chunk_hash: string;
      }>(
        `SELECT id, field_name, span_start, span_end, chunk_hash
           FROM oweibo.kf_chunks WHERE knowledge_object_id = $1::uuid`,
        [objectId],
      );
      const diff = chunksToReindex(
        storedChunks.rows.map((r) => ({
          fieldName: r.field_name, spanStart: r.span_start, spanEnd: r.span_end,
          chunkHash: r.chunk_hash, id: r.id,
        })),
        incoming,
      );
      for (const ch of diff.toUpsert) {
        await c.query(
          `INSERT INTO oweibo.kf_chunks
             (tenant_id, knowledge_object_id, field_name, span_start, span_end, freshness_class, chunk_hash, content, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [input.tenantId, objectId, ch.fieldName, ch.spanStart, ch.spanEnd, ch.freshnessClass, ch.chunkHash, ch.content],
        );
        // Replace-in-place: delete any prior row at the same identity.
        await c.query(
          `DELETE FROM oweibo.kf_chunks
            WHERE knowledge_object_id = $1::uuid AND field_name = $2
              AND span_start = $3 AND span_end = $4 AND chunk_hash <> $5`,
          [objectId, ch.fieldName, ch.spanStart, ch.spanEnd, ch.chunkHash],
        );
      }
      for (const ch of diff.toDelete) {
        await c.query(`DELETE FROM oweibo.kf_chunks WHERE id = $1::uuid`, [(ch as { id: string }).id]);
      }

      // ACL snapshot: version + hash ONLY; platform counter bumps on
      // hash change.
      const snap = await c.query<{ acl_version: string; permission_hash: string }>(
        `SELECT acl_version::text, permission_hash FROM oweibo.kf_acl_snapshots
          WHERE knowledge_object_id = $1::uuid FOR UPDATE`,
        [objectId],
      );
      const prior = snap.rows[0];
      const hashChanged = prior === undefined || prior.permission_hash !== aclResult.aclVersion;
      const nextAclVersion = prior === undefined ? 1 : hashChanged ? Number(prior.acl_version) + 1 : Number(prior.acl_version);
      await c.query(
        `INSERT INTO oweibo.kf_acl_snapshots
           (knowledge_object_id, tenant_id, acl_version, permission_hash, source_revision, last_checked)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW())
         ON CONFLICT (knowledge_object_id)
         DO UPDATE SET acl_version = EXCLUDED.acl_version, permission_hash = EXCLUDED.permission_hash,
                       source_revision = EXCLUDED.source_revision, last_checked = NOW()`,
        [objectId, input.tenantId, nextAclVersion, aclResult.aclVersion, input.sourceRevision],
      );

      // Events, same txn (INV-5).
      const base = {
        tenantId: input.tenantId, source: input.source, document_id: input.documentId,
        source_revision: input.sourceRevision, index_generation: merged.indexGeneration,
        timestamp: new Date().toISOString(),
      };
      await c.query(`INSERT INTO oweibo.outbox (subject, payload) VALUES ('IndexUpdated', $1::jsonb)`,
        [JSON.stringify(base)]);
      if (hashChanged) {
        await c.query(`INSERT INTO oweibo.outbox (subject, payload) VALUES ('ACLUpdated', $1::jsonb)`,
          [JSON.stringify({ ...base, acl_version: nextAclVersion })]);
      }

      // Gap backfill (§3.1): always enqueued on process_gap.
      let backfillEnqueued = false;
      const gap = gapRange(input.sourceRevision, pre.stored);
      if (verdict === 'process_gap' && gap) {
        const queue = new JobQueue(c);
        const r = await queue.enqueue({
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          jobClass: 3,
          idempotencyKey: `backfill:${input.documentId}:${gap.from}-${gap.to}`,
          checkpoint: { documentId: input.documentId, from: gap.from, to: gap.to },
        });
        backfillEnqueued = r.enqueued;
      }

      return {
        outcome: 'indexed' as const,
        knowledgeObjectId: objectId,
        chunksUpserted: diff.toUpsert.length,
        chunksDeleted: diff.toDelete.length,
        backfillEnqueued,
        aclVersionBumped: hashChanged,
        changedChunks: diff.toUpsert.map((ch) => ({
          fieldName: ch.fieldName, spanStart: ch.spanStart, spanEnd: ch.spanEnd,
          freshnessClass: ch.freshnessClass, content: ch.content,
        })),
        deletedChunks: diff.toDelete.map((ch) => {
          const c = ch as { fieldName: string; spanStart: number; spanEnd: number; freshnessClass?: string };
          return { fieldName: c.fieldName, spanStart: c.spanStart, spanEnd: c.spanEnd, freshnessClass: c.freshnessClass ?? 'operational' };
        }),
      };
    });
  }

  /** §3.4 purge: state tombstone; chunks go, vector + provenance stay. */
  private async purge<Ctx>(input: IndexDocumentInput<Ctx>): Promise<IndexDocumentResult> {
    return this.withTenant(input.tenantId, async (c) => {
      const obj = await c.query<{ id: string }>(
        `UPDATE oweibo.kf_knowledge_objects SET state = 'purged', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND connector_id = $2 AND document_id = $3
          RETURNING id`,
        [input.tenantId, input.connectorId, input.documentId],
      );
      const objectId = obj.rows[0]?.id;
      if (!objectId) return { outcome: 'ignored' as const, detail: 'unknown document' };
      const del = await c.query(
        `DELETE FROM oweibo.kf_chunks WHERE knowledge_object_id = $1::uuid`,
        [objectId],
      );
      await c.query(`INSERT INTO oweibo.outbox (subject, payload) VALUES ('IndexUpdated', $1::jsonb)`,
        [JSON.stringify({
          tenantId: input.tenantId, source: input.source, document_id: input.documentId,
          source_revision: input.sourceRevision, state: 'purged',
          timestamp: new Date().toISOString(),
        })]);
      return { outcome: 'purged' as const, knowledgeObjectId: objectId, chunksDeleted: del.rowCount ?? 0 };
    });
  }

  /** Knowledge Runtime's reaction to ReindexRequested (§3.3 step 3). */
  async markStale(input: {
    readonly tenantId: string; readonly connectorId: string; readonly documentId: string;
  }): Promise<{ marked: boolean }> {
    return this.withTenant(input.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE oweibo.kf_knowledge_objects SET state = 'stale', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND connector_id = $2 AND document_id = $3 AND state = 'indexed'`,
        [input.tenantId, input.connectorId, input.documentId],
      );
      return { marked: (r.rowCount ?? 0) > 0 };
    });
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

interface IncomingChunk {
  readonly fieldName: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly chunkHash: string;
  readonly content: string;
  readonly freshnessClass: string;
}

/** Metadata depth: one chunk per field; field boundary = chunk boundary (§5.4). */
export function chunkFields(
  fields: Readonly<Record<string, unknown>>,
  freshnessClasses?: Readonly<Record<string, string>>,
): IncomingChunk[] {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([fieldName, value]) => {
      const content = typeof value === 'string' ? value : JSON.stringify(value);
      return {
        fieldName,
        spanStart: 0,
        spanEnd: content.length,
        chunkHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        content,
        freshnessClass: freshnessClasses?.[fieldName] ?? 'operational',
      };
    });
}

function defaultClasses(fields: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.keys(fields).map((f) => [f, 'operational']));
}
