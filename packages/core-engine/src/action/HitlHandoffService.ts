/**
 * S.7: HitlHandoffService — escalate a plan to human review.
 *
 * Flow per `prepare(args)`:
 *   1. Build a ForensicPacket via ForensicPacketBuilder (signed +
 *      uploaded to storage by the builder).
 *   2. Insert a row into oweibo.forensic_packets with the storage ref
 *      and signature.
 *   3. Pause the plan (mark action_plans row as state='paused_hitl').
 *      Future gate() calls for proposals in this plan short-circuit
 *      to forbidden until the operator resolves the handoff.
 *   4. (Caller-side) the trust ladder / agent loop checks the pause
 *      state before continuing the plan.
 *
 * `resolve()` records the operator's decision (resumed / overridden /
 * aborted / lessons_learned) and updates plan state accordingly.
 *
 * `expireOverdue()` is called by the worker tick: packets older than
 * their expires_at (default 24h) with state IN ('open','under_review')
 * are auto-resolved as aborted and the parent plan is marked failed.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ForensicPacket,
  ForensicResolution,
  ForensicTriggerKind,
} from '@oweibo/core-contracts';
import type { ForensicPacketBuilder } from './ForensicPacketBuilder.js';

export interface HitlHandoffServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
  /** Default packet expiry (seconds). Default 24h. */
  defaultExpirySeconds?: number;
  log?: (level: 'info' | 'warn' | 'error', line: string, ctx?: unknown) => void;
}

export interface PrepareResult {
  readonly forensicPacketRowId: string;
  readonly storageRef: string;
  readonly signature: string;
  readonly packet: ForensicPacket;
}

export class HitlHandoffService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly defaultExpirySeconds: number;
  private readonly log: NonNullable<HitlHandoffServiceOptions['log']>;

  constructor(
    private readonly pool: Pool,
    private readonly builder: ForensicPacketBuilder,
    opts: HitlHandoffServiceOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
    this.defaultExpirySeconds = opts.defaultExpirySeconds ?? 24 * 60 * 60;
    this.log = opts.log ?? defaultLog;
  }

  // ── Prepare ─────────────────────────────────────────────────────────────

  async prepare(args: {
    readonly tenantId: string;
    readonly planId: string;
    readonly triggerKind: ForensicTriggerKind;
    readonly triggeredBy: string;
    readonly summary?: string;
  }): Promise<PrepareResult> {
    if (!this.isEnabled()) {
      throw new Error('HitlHandoffService: forensic_replay.enabled is off');
    }
    // 1. Build packet (this also uploads to storage + signs).
    const built = await this.builder.build({
      tenantId: args.tenantId,
      planId: args.planId,
      triggerKind: args.triggerKind,
      triggeredBy: args.triggeredBy,
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
    });

    const expiresAt = new Date(this.now().getTime() + this.defaultExpirySeconds * 1000);

    // 2. Insert forensic_packets row + 3. pause plan, in a single tx.
    return this.tx(args.tenantId, async (client) => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO oweibo.forensic_packets
           (tenant_id, plan_id, trigger_kind, triggered_by, summary,
            packet_storage_ref, packet_signature, packet_byte_size, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          args.tenantId,
          args.planId,
          args.triggerKind,
          args.triggeredBy,
          built.packet.summary,
          built.storageRef,
          built.signature,
          built.byteSize,
          expiresAt,
        ],
      );
      // Pause the plan if action_plans has a `state` column that
      // supports 'paused_hitl' — otherwise this is a no-op. The S.0
      // schema today carries plan state as a free-form TEXT, so we
      // unconditionally attempt the update.
      await client.query(
        `UPDATE oweibo.action_plans
            SET state = 'paused_hitl'
          WHERE id = $1::uuid`,
        [args.planId],
      ).catch(() => undefined);

      return {
        forensicPacketRowId: ins.rows[0]?.id ?? '',
        storageRef: built.storageRef,
        signature: built.signature,
        packet: built.packet,
      };
    });
  }

  // ── Resolve ─────────────────────────────────────────────────────────────

  async resolve(args: {
    readonly tenantId: string;
    readonly forensicPacketRowId: string;
    readonly resolution: ForensicResolution;
    readonly resolvedByUserId: string;
    readonly notes?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error('HitlHandoffService: forensic_replay.enabled is off');
    }
    await this.tx(args.tenantId, async (client) => {
      const r = await client.query<{ plan_id: string }>(
        `UPDATE oweibo.forensic_packets
            SET state = 'resolved',
                resolution = $2,
                resolution_notes = $3,
                resolved_by = $4::uuid,
                resolved_at = NOW()
          WHERE id = $1::uuid
            AND state IN ('open', 'under_review')
          RETURNING plan_id`,
        [args.forensicPacketRowId, args.resolution, args.notes ?? null, args.resolvedByUserId],
      );
      const planId = r.rows[0]?.plan_id;
      if (!planId) {
        throw new Error(
          `HitlHandoffService.resolve: packet ${args.forensicPacketRowId} not found or already resolved`,
        );
      }
      // Map resolution → plan state.
      const planState = mapResolutionToPlanState(args.resolution);
      await client.query(
        `UPDATE oweibo.action_plans SET state = $2 WHERE id = $1::uuid`,
        [planId, planState],
      ).catch(() => undefined);
    });
  }

  // ── Worker hook: expire overdue packets ────────────────────────────────

  async expireOverdue(limit = 50): Promise<number> {
    if (!this.isEnabled()) return 0;
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
      const r = await client.query<{ id: string; plan_id: string }>(
        `WITH expired AS (
           SELECT id, plan_id FROM oweibo.forensic_packets
            WHERE state IN ('open', 'under_review')
              AND expires_at <= NOW()
            ORDER BY expires_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE oweibo.forensic_packets AS p
            SET state = 'resolved',
                resolution = 'aborted',
                resolution_notes = 'auto-aborted: HITL SLA expired',
                resolved_at = NOW()
           FROM expired
          WHERE p.id = expired.id
          RETURNING p.id, p.plan_id`,
        [limit],
      );
      for (const row of r.rows) {
        await client.query(
          `UPDATE oweibo.action_plans SET state = 'failed' WHERE id = $1::uuid`,
          [row.plan_id],
        ).catch(() => undefined);
      }
      return r.rows.length;
    } finally {
      client.release();
    }
  }

  // ── Reads (used by admin-web detail page) ──────────────────────────────

  async list(tenantId: string, limit = 50): Promise<
    Array<{ id: string; planId: string; state: string; triggerKind: string; createdAt: string; summary: string | null }>
  > {
    return this.tx(tenantId, async (client) => {
      const r = await client.query<{
        id: string;
        plan_id: string;
        state: string;
        trigger_kind: string;
        created_at: Date;
        summary: string | null;
      }>(
        `SELECT id, plan_id, state, trigger_kind, created_at, summary
           FROM oweibo.forensic_packets
          WHERE tenant_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );
      return r.rows.map((row) => ({
        id: row.id,
        planId: row.plan_id,
        state: row.state,
        triggerKind: row.trigger_kind,
        createdAt: row.created_at.toISOString(),
        summary: row.summary,
      }));
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
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

// ── Pure helpers ─────────────────────────────────────────────────────────

function defaultEnabled(): boolean {
  return process.env.FORENSIC_REPLAY_ENABLED === 'true';
}

function defaultLog(level: 'info' | 'warn' | 'error', line: string, _ctx?: unknown): void {
  if (level === 'error') console.error(`[HitlHandoff] ${line}`);
  else if (level === 'warn') console.warn(`[HitlHandoff] ${line}`);
  else console.log(`[HitlHandoff] ${line}`);
}

export function mapResolutionToPlanState(res: ForensicResolution): string {
  switch (res) {
    case 'resumed':         return 'in_progress';
    case 'overridden':      return 'in_progress';
    case 'aborted':         return 'failed';
    case 'lessons_learned': return 'failed';
  }
}
