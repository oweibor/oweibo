/**
 * K.8 — KnowledgeGraphService (arch §8, ADR-002 §3.6): the source-local (and,
 * Phase 3, cross-source) relationship graph. Sole writer (INV-16) of
 * kf_graph_edges (a Knowledge-Runtime component). Edges are eventually
 * consistent (§8.2), tagged with index_generation + source_revision (INV-1),
 * and follow the ADR-003 pending-edge rule; stale edges are retracted via
 * GraphInvalidated (§3.5), never direct-mutated by another subsystem.
 */

import type { Pool, PoolClient } from 'pg';
import { decidePendingEdge } from '../consistency/contract.js';
import {
  graphProximity,
  neighborsByType,
  type GraphEdge,
  type EdgeConfidence,
} from './graphTraversal.js';

export interface AddEdgeInput {
  readonly tenantId: string;
  readonly srcKind: string;
  readonly srcRef: string;
  readonly edgeType: string;
  readonly dstKind: string;
  readonly dstRef: string;
  readonly source: string;
  readonly confidence?: EdgeConfidence; // 'resolved' (default) | 'provisional'
  readonly indexGeneration?: number;
  readonly sourceRevision?: number;
  /**
   * Whether the edge's referent (dst) is already present. False → the edge is
   * held `pending` (ADR-003 pending-edge rule), activated when the referent
   * arrives; true → `active` immediately.
   */
  readonly referentExists?: boolean;
}

export interface WhoOwnsResult {
  readonly owners: readonly string[];
  /** The strictest confidence among the owning edges — drives hedging. */
  readonly confidence: EdgeConfidence;
  /** True when any owning edge is provisional (response must be hedged). */
  readonly provisional: boolean;
}

export class KnowledgeGraphService {
  constructor(private readonly pool: Pool) {}

  /** Write an edge (pending-edge rule); emit GraphUpdated. Idempotent on the edge identity. */
  async addEdge(input: AddEdgeInput): Promise<{ edgeId: string; state: 'active' | 'pending' }> {
    // Referent absent → hold pending (heldForMs 0 at creation → 'hold'); present → active.
    const decision = decidePendingEdge({ referentExists: input.referentExists ?? true, heldForMs: 0 });
    const state = decision === 'activate' ? 'active' : 'pending';

    return this.withTenant(input.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO oweibo.kf_graph_edges
           (tenant_id, src_kind, src_ref, edge_type, dst_kind, dst_ref, source, confidence, state, index_generation, source_revision)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, src_ref, edge_type, dst_ref, source)
         DO UPDATE SET confidence = EXCLUDED.confidence, state = EXCLUDED.state,
                       index_generation = EXCLUDED.index_generation, source_revision = EXCLUDED.source_revision, updated_at = NOW()
         RETURNING id`,
        [
          input.tenantId, input.srcKind, input.srcRef, input.edgeType, input.dstKind, input.dstRef,
          input.source, input.confidence ?? 'resolved', state, input.indexGeneration ?? 0, input.sourceRevision ?? 0,
        ],
      );
      await c.query(
        `INSERT INTO oweibo.outbox (subject, payload) VALUES ('GraphUpdated', $1::jsonb)`,
        [JSON.stringify({
          tenantId: input.tenantId, src_ref: input.srcRef, edge_type: input.edgeType, dst_ref: input.dstRef,
          state, confidence: input.confidence ?? 'resolved', timestamp: new Date().toISOString(),
        })],
      );
      return { edgeId: r.rows[0]!.id, state };
    });
  }

  /**
   * Activate pending edges whose referent has since appeared (as the src or
   * dst of any active edge). Applies the ADR-003 pending-edge decision per
   * held edge. Returns the count activated / expired.
   */
  async activatePending(tenantId: string, expiryMs?: number): Promise<{ activated: number; expired: number }> {
    return this.withTenant(tenantId, async (c) => {
      const pending = await c.query<{ id: string; dst_ref: string; created_at: string }>(
        `SELECT id, dst_ref, created_at FROM oweibo.kf_graph_edges
          WHERE tenant_id = $1::uuid AND state = 'pending'`,
        [tenantId],
      );
      let activated = 0;
      let expired = 0;
      for (const edge of pending.rows) {
        const ref = await c.query(
          `SELECT 1 FROM oweibo.kf_graph_edges
            WHERE tenant_id = $1::uuid AND state = 'active' AND (src_ref = $2 OR dst_ref = $2) LIMIT 1`,
          [tenantId, edge.dst_ref],
        );
        const heldForMs = Date.now() - new Date(edge.created_at).getTime();
        const decision = decidePendingEdge({
          referentExists: (ref.rowCount ?? 0) > 0, heldForMs, ...(expiryMs !== undefined ? { expiryMs } : {}),
        });
        if (decision === 'activate') {
          await c.query(`UPDATE oweibo.kf_graph_edges SET state = 'active', updated_at = NOW() WHERE id = $1::uuid`, [edge.id]);
          activated += 1;
        } else if (decision === 'expire') {
          await c.query(`UPDATE oweibo.kf_graph_edges SET state = 'retracted', updated_at = NOW() WHERE id = $1::uuid`, [edge.id]);
          expired += 1;
        }
      }
      return { activated, expired };
    });
  }

  /**
   * §3.5 GraphInvalidated consumer: retract every edge referencing a rejected
   * canonical identity or its source principal. This is the ASYNC retraction —
   * edges leave traversal by state change, never a hard delete (§8.2).
   */
  async retractForPrincipal(tenantId: string, principalRef: string): Promise<{ retracted: number }> {
    return this.withTenant(tenantId, async (c) => {
      const r = await c.query(
        `UPDATE oweibo.kf_graph_edges SET state = 'retracted', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND state <> 'retracted' AND (src_ref = $2 OR dst_ref = $2)`,
        [tenantId, principalRef],
      );
      return { retracted: r.rowCount ?? 0 };
    });
  }

  /** Load all ACTIVE edges for traversal/proximity (retrieval reads; never writes). */
  async loadActiveEdges(tenantId: string): Promise<GraphEdge[]> {
    return this.withTenant(tenantId, (c) =>
      c.query<{ src_ref: string; dst_ref: string; edge_type: string; state: string; confidence: string }>(
        `SELECT src_ref, dst_ref, edge_type, state, confidence FROM oweibo.kf_graph_edges
          WHERE tenant_id = $1::uuid AND state = 'active'`,
        [tenantId],
      ).then((r) => r.rows.map((x) => ({
        srcRef: x.src_ref, dstRef: x.dst_ref, edgeType: x.edge_type,
        state: 'active' as const, confidence: x.confidence as EdgeConfidence,
      }))),
    );
  }

  /**
   * "Who owns X?" — the graph answer (§7.2 example, K.8 exit gate). Returns the
   * owning principals plus whether the answer must be hedged (any provisional
   * owning edge). The confidence tag propagates to provenance (ADR-007).
   */
  async whoOwns(tenantId: string, objectRef: string): Promise<WhoOwnsResult> {
    const rows = await this.withTenant(tenantId, (c) =>
      c.query<{ src_ref: string; confidence: string }>(
        `SELECT src_ref, confidence FROM oweibo.kf_graph_edges
          WHERE tenant_id = $1::uuid AND state = 'active' AND edge_type = 'owns' AND dst_ref = $2`,
        [tenantId, objectRef],
      ).then((r) => r.rows),
    );
    const owners = rows.map((r) => r.src_ref);
    const provisional = rows.some((r) => r.confidence === 'provisional');
    return { owners, confidence: provisional ? 'provisional' : 'resolved', provisional };
  }

  /** Graph proximity between two nodes for the hybridRank signal (§3.6). */
  async proximity(tenantId: string, a: string, b: string): Promise<number> {
    const edges = await this.loadActiveEdges(tenantId);
    return graphProximity(edges, a, b);
  }

  /** Neighbours of a node by edge type over active edges (traversal primitive). */
  async neighbors(tenantId: string, node: string, edgeType: string, direction: 'out' | 'in' = 'out'): Promise<string[]> {
    const edges = await this.loadActiveEdges(tenantId);
    return neighborsByType(edges, node, edgeType, direction);
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
