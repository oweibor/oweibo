/**
 * T.2.h: OrgGraphService — CRUD over the org-graph tables + approver
 * resolution used by T.−1's require_approval routing.
 *
 * resolveApprovers(tenantId, actionClass) walks the graph for any
 * decision_body node with an 'approves' edge whose metadata.actionClasses
 * includes the requested class (or '*'). It then collects every node
 * with a 'member_of' edge pointing at that body. If no such body exists,
 * `fromGraph: false` signals the caller to fall back to today's
 * tenant-admin role lookup — preserving backwards compatibility.
 *
 * All queries run under tenant RLS; the service expects the caller to
 * have set app.tenant_id (typically via withTenantContext upstream).
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ApproverResolution,
  OrgEdge,
  OrgEdgeType,
  OrgFact,
  OrgFactSource,
  OrgNode,
  OrgNodeType,
  OrgStakeholderInterest,
} from '@oweibo/core-contracts';

export interface CreateNodeInput {
  readonly tenantId: string;
  readonly nodeType: OrgNodeType;
  readonly label: string;
  readonly userId?: string | null;
  readonly externalRef?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateEdgeInput {
  readonly tenantId: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly edgeType: OrgEdgeType;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpsertFactInput {
  readonly tenantId: string;
  readonly nodeId: string;
  readonly factKey: string;
  readonly factValue: string;
  readonly source: OrgFactSource;
}

export class OrgGraphService {
  constructor(private readonly pool: Pool) {}

  // ── Nodes ──────────────────────────────────────────────────────────────

  async createNode(input: CreateNodeInput): Promise<OrgNode> {
    return this.tx(input.tenantId, async (client) => {
      const result = await client.query<DbOrgNodeRow>(
        `INSERT INTO oweibo.org_nodes (tenant_id, node_type, label, user_id, external_ref, metadata)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb)
         RETURNING id, tenant_id, node_type, label, user_id, external_ref, metadata, created_at, updated_at`,
        [
          input.tenantId,
          input.nodeType,
          input.label,
          input.userId ?? null,
          input.externalRef ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('OrgGraphService.createNode: insert returned no row');
      return toNode(row);
    });
  }

  async listNodes(tenantId: string, opts: { nodeType?: OrgNodeType } = {}): Promise<OrgNode[]> {
    return this.tx(tenantId, async (client) => {
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1::uuid';
      if (opts.nodeType) {
        params.push(opts.nodeType);
        where += ` AND node_type = $${params.length}`;
      }
      const result = await client.query<DbOrgNodeRow>(
        `SELECT id, tenant_id, node_type, label, user_id, external_ref, metadata, created_at, updated_at
           FROM oweibo.org_nodes
          WHERE ${where}
          ORDER BY created_at ASC`,
        params,
      );
      return result.rows.map(toNode);
    });
  }

  // ── Edges ──────────────────────────────────────────────────────────────

  async createEdge(input: CreateEdgeInput): Promise<OrgEdge> {
    return this.tx(input.tenantId, async (client) => {
      const result = await client.query<DbOrgEdgeRow>(
        `INSERT INTO oweibo.org_edges (tenant_id, from_node, to_node, edge_type, metadata)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)
         ON CONFLICT (tenant_id, from_node, to_node, edge_type)
           DO UPDATE SET metadata = EXCLUDED.metadata
         RETURNING id, tenant_id, from_node, to_node, edge_type, metadata, created_at`,
        [
          input.tenantId,
          input.fromNode,
          input.toNode,
          input.edgeType,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('OrgGraphService.createEdge: insert returned no row');
      return toEdge(row);
    });
  }

  async listEdges(tenantId: string, opts: { fromNode?: string; edgeType?: OrgEdgeType } = {}): Promise<OrgEdge[]> {
    return this.tx(tenantId, async (client) => {
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1::uuid';
      if (opts.fromNode) {
        params.push(opts.fromNode);
        where += ` AND from_node = $${params.length}::uuid`;
      }
      if (opts.edgeType) {
        params.push(opts.edgeType);
        where += ` AND edge_type = $${params.length}`;
      }
      const result = await client.query<DbOrgEdgeRow>(
        `SELECT id, tenant_id, from_node, to_node, edge_type, metadata, created_at
           FROM oweibo.org_edges
          WHERE ${where}
          ORDER BY created_at ASC`,
        params,
      );
      return result.rows.map(toEdge);
    });
  }

  // ── Facts ──────────────────────────────────────────────────────────────

  async upsertFact(input: UpsertFactInput): Promise<OrgFact> {
    return this.tx(input.tenantId, async (client) => {
      const result = await client.query<DbOrgFactRow>(
        `INSERT INTO oweibo.org_facts (tenant_id, node_id, fact_key, fact_value, source)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)
         ON CONFLICT (tenant_id, node_id, fact_key)
           DO UPDATE SET fact_value = EXCLUDED.fact_value,
                         source     = EXCLUDED.source,
                         updated_at = NOW()
         RETURNING id, tenant_id, node_id, fact_key, fact_value, source, created_at, updated_at`,
        [input.tenantId, input.nodeId, input.factKey, input.factValue, input.source],
      );
      const row = result.rows[0];
      if (!row) throw new Error('OrgGraphService.upsertFact: insert returned no row');
      return toFact(row);
    });
  }

  async listFacts(tenantId: string, nodeId?: string): Promise<OrgFact[]> {
    return this.tx(tenantId, async (client) => {
      const params: unknown[] = [tenantId];
      let where = 'tenant_id = $1::uuid';
      if (nodeId) {
        params.push(nodeId);
        where += ` AND node_id = $${params.length}::uuid`;
      }
      const result = await client.query<DbOrgFactRow>(
        `SELECT id, tenant_id, node_id, fact_key, fact_value, source, created_at, updated_at
           FROM oweibo.org_facts
          WHERE ${where}
          ORDER BY fact_key ASC`,
        params,
      );
      return result.rows.map(toFact);
    });
  }

  // ── Stakeholder interests ──────────────────────────────────────────────

  async setStakeholderInterest(
    tenantId: string,
    nodeId: string,
    domain: string,
    weight: number,
  ): Promise<OrgStakeholderInterest> {
    if (weight < 0 || weight > 1) throw new RangeError('weight must be in [0,1]');
    return this.tx(tenantId, async (client) => {
      const result = await client.query<{ id: string; tenant_id: string; node_id: string; domain: string; weight: string }>(
        `INSERT INTO oweibo.org_stakeholder_interests (tenant_id, node_id, domain, weight)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         ON CONFLICT (tenant_id, node_id, domain)
           DO UPDATE SET weight = EXCLUDED.weight
         RETURNING id, tenant_id, node_id, domain, weight::text AS weight`,
        [tenantId, nodeId, domain, weight],
      );
      const row = result.rows[0];
      if (!row) throw new Error('setStakeholderInterest: no row');
      return {
        id: row.id,
        tenantId: row.tenant_id,
        nodeId: row.node_id,
        domain: row.domain,
        weight: Number(row.weight),
      };
    });
  }

  // ── Approver resolution ────────────────────────────────────────────────

  /**
   * Find every node authorised to approve actions of the given class. A
   * decision_body matches when it has an outgoing 'approves' edge whose
   * metadata.actionClasses includes the requested class or '*'. Members
   * of that body are collected via 'member_of' edges pointing at it.
   *
   * Returns { fromGraph: false } when no matching body exists, signalling
   * the caller to fall back to tenant-admin role lookup.
   */
  async resolveApprovers(tenantId: string, actionClass: string): Promise<ApproverResolution> {
    return this.tx(tenantId, async (client) => {
      // Find all decision_body nodes with an outgoing 'approves' edge.
      const bodies = await client.query<{ id: string; metadata: unknown }>(
        `SELECT n.id, e.metadata
           FROM oweibo.org_nodes n
           JOIN oweibo.org_edges e
             ON e.tenant_id = n.tenant_id
            AND e.from_node = n.id
            AND e.edge_type = 'approves'
          WHERE n.tenant_id = $1::uuid
            AND n.node_type = 'decision_body'`,
        [tenantId],
      );

      const matchingBodies: string[] = [];
      for (const row of bodies.rows) {
        const meta = (row.metadata ?? {}) as { actionClasses?: readonly string[] };
        const classes = meta.actionClasses ?? [];
        if (classes.includes('*') || classes.includes(actionClass)) {
          matchingBodies.push(row.id);
        }
      }

      if (matchingBodies.length === 0) {
        return { nodes: [], users: [], fromGraph: false };
      }

      // Collect member_of nodes pointing at the matching bodies.
      const members = await client.query<{ id: string; user_id: string | null }>(
        `SELECT n.id, n.user_id
           FROM oweibo.org_nodes n
           JOIN oweibo.org_edges e
             ON e.tenant_id = n.tenant_id
            AND e.from_node = n.id
            AND e.edge_type = 'member_of'
            AND e.to_node = ANY($2::uuid[])
          WHERE n.tenant_id = $1::uuid`,
        [tenantId, matchingBodies],
      );

      const nodeSet = new Set<string>();
      const userSet = new Set<string>();
      for (const r of members.rows) {
        nodeSet.add(r.id);
        if (r.user_id) userSet.add(r.user_id);
      }
      return {
        nodes: Array.from(nodeSet),
        users: Array.from(userSet),
        fromGraph: true,
      };
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

// ── Row mappers ───────────────────────────────────────────────────────────

interface DbOrgNodeRow {
  id: string; tenant_id: string; node_type: string; label: string;
  user_id: string | null; external_ref: string | null;
  metadata: unknown; created_at: Date | string; updated_at: Date | string;
}
interface DbOrgEdgeRow {
  id: string; tenant_id: string; from_node: string; to_node: string;
  edge_type: string; metadata: unknown; created_at: Date | string;
}
interface DbOrgFactRow {
  id: string; tenant_id: string; node_id: string; fact_key: string; fact_value: string;
  source: string; created_at: Date | string; updated_at: Date | string;
}

function asIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function toNode(r: DbOrgNodeRow): OrgNode {
  return {
    id: r.id, tenantId: r.tenant_id, nodeType: r.node_type as OrgNodeType,
    label: r.label, userId: r.user_id, externalRef: r.external_ref,
    metadata: (r.metadata ?? {}) as Readonly<Record<string, unknown>>,
    createdAt: asIso(r.created_at), updatedAt: asIso(r.updated_at),
  };
}
function toEdge(r: DbOrgEdgeRow): OrgEdge {
  return {
    id: r.id, tenantId: r.tenant_id, fromNode: r.from_node, toNode: r.to_node,
    edgeType: r.edge_type as OrgEdgeType,
    metadata: (r.metadata ?? {}) as Readonly<Record<string, unknown>>,
    createdAt: asIso(r.created_at),
  };
}
function toFact(r: DbOrgFactRow): OrgFact {
  return {
    id: r.id, tenantId: r.tenant_id, nodeId: r.node_id, factKey: r.fact_key,
    factValue: r.fact_value, source: r.source as OrgFactSource,
    createdAt: asIso(r.created_at), updatedAt: asIso(r.updated_at),
  };
}
