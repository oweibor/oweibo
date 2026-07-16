/**
 * K.2 — MembershipSyncService (ADR-010 §3.2): drains a connector's
 * PrincipalsPort into kf_principal_seeds + kf_membership_records and
 * emits MembershipChanged through the transactional outbox.
 *
 * Contract points implemented here:
 *  - Rows are raw edges (user→group AND group→group from memberGroups);
 *    flattening never happens on the write path.
 *  - Removals are HARD row deletes — membership is current-state; the
 *    event stream is the history.
 *  - Any observed add/remove bumps the per-(tenant, source)
 *    membership_version and emits ONE MembershipChanged per sync batch,
 *    payload keyed by affected group refs (consumers invalidate by
 *    group, not by row).
 *  - Event insert happens in the SAME transaction as the edge writes
 *    (transactional outbox → INV-5 by construction; OutboxRelay
 *    publishes with INV-6 at-least-once).
 *  - Job-class assignment: bootstrap = class 2, delta = class 1
 *    (INV-9 — never shed). enqueueDeltaSync is the scheduler hook.
 *
 * RLS: every statement runs inside a transaction carrying
 * app.tenant_id, on the caller-supplied pool (oweibo_app).
 */
import type { Pool, PoolClient } from 'pg';
import { JobQueue } from '../scheduler/index.js';
import {
  MEMBERSHIP_BOOTSTRAP_JOB_CLASS,
  MEMBERSHIP_DELTA_JOB_CLASS,
} from '../permissions/contract.js';

// Structural mirrors of the SDK's PrincipalsPort surface (ADR-012 §3.2).
// Deliberately NOT an import: core-engine does not depend on
// @oweibo/connector-sdk today, and whether the engine takes that edge is
// the K.3 runtime-composition decision. TypeScript's structural typing
// means the real port satisfies these shapes exactly; if the SDK shape
// drifts, the K.3 composition point is where the mismatch surfaces.

export interface SyncSourcePrincipal {
  readonly id: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly status: 'active' | 'suspended' | 'deleted';
}

export interface SyncSourceGroup {
  readonly id: string;
  readonly displayName?: string;
  readonly memberPrincipals: readonly string[];
  readonly memberGroups: readonly string[];
}

interface SyncPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface SyncPrincipalsPort<Ctx> {
  listPrincipals(ctx: Ctx, cursor: string | null): Promise<SyncPage<SyncSourcePrincipal>>;
  listGroups?(ctx: Ctx, cursor: string | null): Promise<SyncPage<SyncSourceGroup>>;
}

export interface MembershipSyncResult {
  readonly principalsUpserted: number;
  readonly edgesAdded: number;
  readonly edgesRemoved: number;
  /** Post-sync membership_version for (tenant, source); unchanged when no diff. */
  readonly membershipVersion: number;
  /** True iff a MembershipChanged event was emitted (i.e., something changed). */
  readonly emitted: boolean;
}

export class MembershipSyncService {
  constructor(private readonly pool: Pool) {}

  /**
   * Full sync: drain the port, upsert principal seeds, diff edges
   * against the stored set, apply adds/removes, bump the version and
   * emit MembershipChanged when anything changed. Used for both
   * bootstrap (first run — everything is an add) and delta polls (the
   * diff is the delta); the job CLASS differs, the mechanics don't.
   */
  async sync<Ctx>(input: {
    readonly tenantId: string;
    readonly source: string;
    readonly port: SyncPrincipalsPort<Ctx>;
    readonly ctx: Ctx;
  }): Promise<MembershipSyncResult> {
    const { tenantId, source, port, ctx } = input;

    // Drain the port OUTSIDE the transaction — source round-trips must
    // never hold row locks open.
    const principals = await drainList((c) => port.listPrincipals(ctx, c));
    const groups = port.listGroups ? await drainList((c) => port.listGroups!(ctx, c)) : [];
    const observedEdges = edgesOf(groups);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      // Principal seeds (verified email only — the port already maps
      // status and lowercases emails).
      let principalsUpserted = 0;
      for (const p of principals) {
        await client.query(
          `INSERT INTO oweibo.kf_principal_seeds
             (tenant_id, source, principal_ref, verified_email, display_name, status, observed_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT ON CONSTRAINT kf_principal_seeds_unique_principal
           DO UPDATE SET verified_email = EXCLUDED.verified_email,
                         display_name   = EXCLUDED.display_name,
                         status         = EXCLUDED.status,
                         observed_at    = NOW()`,
          [tenantId, source, p.id, p.email ?? null, p.displayName ?? null, p.status],
        );
        principalsUpserted += 1;
      }

      // Diff stored edges vs observed.
      const stored = await client.query<{ principal_ref: string; group_ref: string }>(
        `SELECT principal_ref, group_ref
           FROM oweibo.kf_membership_records
          WHERE tenant_id = $1::uuid AND source = $2`,
        [tenantId, source],
      );
      const storedSet = new Set(stored.rows.map((r) => edgeKey(r.principal_ref, r.group_ref)));
      const observedSet = new Set(observedEdges.map((e) => edgeKey(e.principalRef, e.groupRef)));

      const toAdd = observedEdges.filter((e) => !storedSet.has(edgeKey(e.principalRef, e.groupRef)));
      const toRemove = stored.rows.filter((r) => !observedSet.has(edgeKey(r.principal_ref, r.group_ref)));

      const currentVersion = await this.currentVersion(client, tenantId, source);
      if (toAdd.length === 0 && toRemove.length === 0) {
        await client.query('COMMIT');
        return {
          principalsUpserted,
          edgesAdded: 0,
          edgesRemoved: 0,
          membershipVersion: currentVersion,
          emitted: false,
        };
      }

      const newVersion = currentVersion + 1;
      for (const e of toAdd) {
        await client.query(
          `INSERT INTO oweibo.kf_membership_records
             (tenant_id, source, principal_ref, group_ref, membership_version, observed_at)
           VALUES ($1::uuid, $2, $3, $4, $5, NOW())
           ON CONFLICT ON CONSTRAINT kf_membership_records_unique_edge DO NOTHING`,
          [tenantId, source, e.principalRef, e.groupRef, newVersion],
        );
      }
      for (const r of toRemove) {
        // Hard delete — membership is current-state (ADR-010 §3.2).
        await client.query(
          `DELETE FROM oweibo.kf_membership_records
            WHERE tenant_id = $1::uuid AND source = $2
              AND principal_ref = $3 AND group_ref = $4`,
          [tenantId, source, r.principal_ref, r.group_ref],
        );
      }

      // Affected groups: every group touched by an add or remove.
      const affectedGroups = [...new Set([
        ...toAdd.map((e) => e.groupRef),
        ...toRemove.map((r) => r.group_ref),
      ])].sort();

      // Transactional outbox — same txn as the writes (INV-5).
      await client.query(
        `INSERT INTO oweibo.outbox (subject, payload) VALUES ('MembershipChanged', $1::jsonb)`,
        [JSON.stringify({
          tenantId,
          source,
          membershipVersion: newVersion,
          affectedGroupRefs: affectedGroups,
          timestamp: new Date().toISOString(),
        })],
      );

      await client.query('COMMIT');
      return {
        principalsUpserted,
        edgesAdded: toAdd.length,
        edgesRemoved: toRemove.length,
        membershipVersion: newVersion,
        emitted: true,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Scheduler hooks (ADR-013 queue): bootstrap crawls are class-2;
   * delta polls are class-1 and are NEVER shed (INV-9). Idempotency
   * keys make duplicate scheduling a no-op.
   */
  async enqueueBootstrap(queue: JobQueue, tenantId: string, connectorId: string): Promise<{ enqueued: boolean }> {
    return queue.enqueue({
      tenantId,
      connectorId,
      jobClass: MEMBERSHIP_BOOTSTRAP_JOB_CLASS as 2,
      idempotencyKey: `membership_bootstrap:${connectorId}`,
    });
  }

  async enqueueDeltaSync(queue: JobQueue, tenantId: string, connectorId: string, pollEpoch: number): Promise<{ enqueued: boolean }> {
    return queue.enqueue({
      tenantId,
      connectorId,
      jobClass: MEMBERSHIP_DELTA_JOB_CLASS as 1,
      idempotencyKey: `membership_delta:${connectorId}:${pollEpoch}`,
    });
  }

  private async currentVersion(client: PoolClient, tenantId: string, source: string): Promise<number> {
    const r = await client.query<{ v: string | null }>(
      `SELECT MAX(membership_version)::text AS v
         FROM oweibo.kf_membership_records
        WHERE tenant_id = $1::uuid AND source = $2`,
      [tenantId, source],
    );
    return r.rows[0]?.v ? Number(r.rows[0].v) : 0;
  }
}

function edgeKey(principalRef: string, groupRef: string): string {
  return `${principalRef}\u0000${groupRef}`;
}

function edgesOf(groups: readonly SyncSourceGroup[]): Array<{ principalRef: string; groupRef: string }> {
  const edges: Array<{ principalRef: string; groupRef: string }> = [];
  for (const g of groups) {
    for (const m of g.memberPrincipals) edges.push({ principalRef: m, groupRef: g.id });
    for (const nested of g.memberGroups) edges.push({ principalRef: nested, groupRef: g.id });
  }
  return edges;
}

async function drainList<T>(list: (cursor: string | null) => Promise<{ items: readonly T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    if (pages++ > 10_000) throw new Error('MembershipSyncService: directory listing did not terminate');
    const page = await list(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}
