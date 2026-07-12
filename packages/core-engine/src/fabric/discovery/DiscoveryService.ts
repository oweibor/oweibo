/**
 * K.3 — DiscoveryService: drains a connector's change feed and turns
 * changes into (a) DocumentDiscovered/Changed/Deleted events through the
 * transactional outbox and (b) indexing jobs on the scheduler.
 *
 * INV-16 discipline: Discovery NEVER writes kf_knowledge_objects (or any
 * knowledge store) — it is a *cause*; Knowledge Runtime (IndexingService)
 * is the sole writer, reacting to the jobs/events produced here.
 *
 * Job classes (ADR-013): acl_changed and deleted are class 1 (permission
 * correctness / deletes are never shed, INV-9); created/updated content
 * indexing is class 3. Idempotency key = document_id:source_revision
 * (duplicate discovery of the same revision is a no-op, INV-6).
 */
import type { Pool } from 'pg';
import { JobQueue } from '../scheduler/index.js';

// Structural mirror of the SDK ChangeFeedPort surface (same rationale as
// MembershipSyncService: the engine takes no connector-sdk dependency;
// composition binds the real port at the K.3+ runtime seam).
export interface SyncChangeEvent {
  readonly ref: string;
  readonly kind: 'created' | 'updated' | 'deleted' | 'acl_changed';
  readonly sourceRevision?: string;
  readonly occurredAt?: string;
}
export interface SyncChangeFeedPort<Ctx> {
  listChanges(ctx: Ctx, cursor: string | null): Promise<{
    readonly items: readonly SyncChangeEvent[];
    readonly nextCursor: string | null;
  }>;
}

export interface DiscoveryPollResult {
  readonly discovered: number;
  readonly deleted: number;
  readonly jobsEnqueued: number;
  /** Persist and pass back next poll (the checkpointed resume point). */
  readonly nextCursor: string | null;
}

export class DiscoveryService {
  constructor(private readonly pool: Pool) {}

  async poll<Ctx>(input: {
    readonly tenantId: string;
    readonly connectorId: string;
    readonly source: string;
    readonly port: SyncChangeFeedPort<Ctx>;
    readonly ctx: Ctx;
    readonly cursor: string | null;
    /** Bounded work per poll; the cursor carries the rest to the next tick. */
    readonly maxPages?: number;
  }): Promise<DiscoveryPollResult> {
    const maxPages = input.maxPages ?? 50;

    // Drain OUTSIDE the transaction (source round-trips never hold locks).
    const events: SyncChangeEvent[] = [];
    let cursor = input.cursor;
    for (let pages = 0; pages < maxPages; pages++) {
      const page = await input.port.listChanges(input.ctx, cursor);
      events.push(...page.items);
      if (page.nextCursor === null) { cursor = null; break; }
      if (page.items.length === 0) { cursor = page.nextCursor; break; }  // caught-up tail
      cursor = page.nextCursor;
    }

    if (events.length === 0) {
      return { discovered: 0, deleted: 0, jobsEnqueued: 0, nextCursor: cursor };
    }

    const client = await this.pool.connect();
    let discovered = 0;
    let deleted = 0;
    let jobsEnqueued = 0;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [input.tenantId]);
      const queue = new JobQueue(client);

      for (const e of events) {
        const revision = e.sourceRevision ?? '0';
        const subject = e.kind === 'deleted' ? 'DocumentDeleted'
          : e.kind === 'created' ? 'DocumentDiscovered'
          : 'DocumentChanged';
        // Outbox in the SAME transaction as the job insert (INV-5).
        await client.query(
          `INSERT INTO oweibo.outbox (subject, payload) VALUES ($1, $2::jsonb)`,
          [subject, JSON.stringify({
            tenantId: input.tenantId,
            source: input.source,
            document_id: e.ref,
            source_revision: Number(revision),
            kind: e.kind,
            timestamp: new Date().toISOString(),
          })],
        );
        const r = await queue.enqueue({
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          jobClass: e.kind === 'deleted' || e.kind === 'acl_changed' ? 1 : 3,
          idempotencyKey: `index:${e.ref}:${e.kind}:${revision}`,
          checkpoint: { documentId: e.ref, kind: e.kind, sourceRevision: Number(revision) },
        });
        if (r.enqueued) jobsEnqueued += 1;
        if (e.kind === 'deleted') deleted += 1;
        else discovered += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    return { discovered, deleted, jobsEnqueued, nextCursor: cursor };
  }
}
