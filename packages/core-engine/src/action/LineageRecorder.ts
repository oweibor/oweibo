/**
 * S.0: LineageRecorder — append-only writer for `oweibo.action_lineage`.
 *
 * Lineage rows are write-once. The recorder takes a tenant-scoped pool
 * connection, sets the RLS tenant scope, and inserts. Returns the
 * generated node id so callers can wire parent → child links.
 *
 * Used by:
 *   - `ActionPlanGate.gatePlan()` writes a `gate_decision` node
 *   - the execution path writes `execution` + (S.5) `verification` nodes
 *   - the rollback worker (S.3) writes `rollback` nodes
 *
 * Failures here MUST NOT block the action path — lineage is observability,
 * not authorisation. The recorder logs and swallows on failure; callers
 * that care can call the strict `recordOrThrow()` variant.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ILineageRecorder,
  ActionLineageNode,
  LineageNodeKind,
  LineageProducerType,
} from '@oweibo/core-contracts';

export interface LineageRecorderOptions {
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

export interface RecordRequest {
  readonly tenantId: string;
  readonly planId: string;
  readonly parentNodeId: string | null;
  readonly kind: LineageNodeKind;
  readonly producer: { readonly type: LineageProducerType; readonly id: string };
  readonly summary: string;
  readonly detail: unknown;
  readonly traceId?: string;
}

export class LineageRecorder implements ILineageRecorder {
  private readonly log: NonNullable<LineageRecorderOptions['log']>;

  constructor(private readonly pool: Pool, opts: LineageRecorderOptions = {}) {
    this.log = opts.log ?? defaultLog;
  }

  /** Best-effort write. Returns nodeId on success, empty string on failure. */
  async record(req: RecordRequest): Promise<string> {
    try {
      return await this.recordOrThrow(req);
    } catch (err) {
      this.log('error', 'LineageRecorder.record swallowed failure', {
        error: err instanceof Error ? err.message : String(err),
        kind: req.kind,
        planId: req.planId,
      });
      return '';
    }
  }

  async recordOrThrow(req: RecordRequest): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScope(client, req.tenantId);
      const result = await client.query<{ id: string }>(
        `INSERT INTO oweibo.action_lineage (
           tenant_id, plan_id, parent_node_id, kind,
           producer_type, producer_id, summary, detail, trace_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9
         )
         RETURNING id`,
        [
          req.tenantId,
          req.planId,
          req.parentNodeId,
          req.kind,
          req.producer.type,
          req.producer.id,
          req.summary,
          JSON.stringify(req.detail ?? null),
          req.traceId ?? null,
        ],
      );
      await client.query('COMMIT');
      const id = result.rows[0]?.id;
      if (!id) throw new Error('LineageRecorder: insert returned no id');
      return id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Read the full lineage tree for a plan. Used by S.7 forensic replay. */
  async readPlanLineage(tenantId: string, planId: string): Promise<readonly ActionLineageNode[]> {
    const client = await this.pool.connect();
    try {
      await setTenantScope(client, tenantId);
      const r = await client.query<{
        id: string;
        plan_id: string;
        parent_node_id: string | null;
        kind: string;
        producer_type: string;
        producer_id: string;
        summary: string;
        detail: unknown;
        trace_id: string | null;
        recorded_at: Date;
      }>(
        `SELECT id, plan_id, parent_node_id, kind, producer_type, producer_id,
                summary, detail, trace_id, recorded_at
           FROM oweibo.action_lineage
          WHERE plan_id = $1::uuid
          ORDER BY recorded_at`,
        [planId],
      );
      return r.rows.map((row) => ({
        nodeId: row.id,
        planId: row.plan_id,
        parentNodeId: row.parent_node_id,
        kind: row.kind as LineageNodeKind,
        producer: { type: row.producer_type as LineageProducerType, id: row.producer_id },
        summary: row.summary,
        detail: row.detail,
        recordedAt: row.recorded_at.toISOString(),
        ...(row.trace_id ? { traceId: row.trace_id } : {}),
      }));
    } finally {
      client.release();
    }
  }
}

async function setTenantScope(client: PoolClient, tenantId: string): Promise<void> {
  if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  }
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === 'error') console.error(`[LineageRecorder] ${line}`);
  else if (level === 'warn') console.warn(`[LineageRecorder] ${line}`);
  else console.log(`[LineageRecorder] ${line}`);
}
