/**
 * F.5.5 (ttv-finals): PgTenantCloner adapter.
 *
 * Wraps TenantCloneSeeder with Pg-backed CloneInfra implementations for
 * the scopes that are pure SQL: projects, org_graph, settings,
 * connectors_recommend. The memories scope stays optional — operators
 * supply a Qdrant-aware copyMemories function via the constructor when
 * they want T.9 organic-memory cloning enabled (separate concern from
 * F.5.9 bootstrap memory seeding).
 *
 * Parent existence: before delegating to the seeder, query
 * oweibo.tenants for the parent id. When the row is missing the cloner
 * returns a synthetic "skipped" CloneSummary with one entry per
 * requested scope carrying error='parent_tenant_missing' — matches
 * plan §F.5.5 edge case "log + skip with reason `parent_tenant_missing`".
 */
import type { Pool, PoolClient } from 'pg';
import {
  TenantCloneSeeder,
  type CloneInfra,
  type CloneScope,
  type CloneScopeResult,
} from '../TenantCloneSeeder.js';

export interface PgTenantClonerOptions {
  /** Optional Qdrant-backed memory copier — when absent, memories scope skips. */
  copyMemories?: CloneInfra['copyMemories'];
  /** Optional audit sink — typically wired to OutboxRelay.publish. */
  audit?: CloneInfra['audit'];
}

export class PgTenantCloner {
  private readonly seeder: TenantCloneSeeder;

  constructor(private readonly pool: Pool, opts: PgTenantClonerOptions = {}) {
    const infra: CloneInfra = {
      ...(opts.copyMemories ? { copyMemories: opts.copyMemories } : {}),
      ...(opts.audit ? { audit: opts.audit } : {}),
      copyProjects: (parent, child) => this.copyProjects(parent, child),
      copyOrgGraph: (parent, child) => this.copyOrgGraph(parent, child),
      copySettings: (parent, child) => this.copySettings(parent, child),
      recommendConnectors: (parent, child) => this.recommendConnectorsFromParent(parent, child),
    };
    this.seeder = new TenantCloneSeeder(infra);
  }

  /** Probe parent existence, then dispatch each requested scope through TenantCloneSeeder. */
  async clone(req: {
    readonly parentTenantId: string;
    readonly childTenantId: string;
    readonly scopes: readonly CloneScope[];
  }): Promise<{ readonly results: readonly CloneScopeResult[] }> {
    const parentExists = await this.tenantExists(req.parentTenantId);
    if (!parentExists) {
      return {
        results: req.scopes.map((scope): CloneScopeResult => ({
          scope, status: 'skipped', error: 'parent_tenant_missing',
        })),
      };
    }
    return this.seeder.clone(req);
  }

  // ── Infra primitives ───────────────────────────────────────────────────

  private async tenantExists(tenantId: string): Promise<boolean> {
    const r = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM oweibo.tenants WHERE id = $1::uuid) AS exists`,
      [tenantId],
    );
    return r.rows[0]?.exists === true;
  }

  private async copyProjects(parent: string, child: string): Promise<number> {
    return this.txPlatform(async (client) => {
      const r = await client.query(
        `INSERT INTO oweibo.tenant_projects
            (tenant_id, template_slug, name, spec, state)
          SELECT $2::uuid, template_slug,
                 '[from parent] ' || name,
                 spec, 'active'
            FROM oweibo.tenant_projects
           WHERE tenant_id = $1::uuid
             AND state = 'active'
          ON CONFLICT ON CONSTRAINT tenant_projects_unique_starter DO NOTHING`,
        [parent, child],
      );
      return r.rowCount ?? 0;
    });
  }

  private async copyOrgGraph(parent: string, child: string): Promise<number> {
    return this.txPlatform(async (client) => {
      // Person nodes: shell (user_id NULL) so FK invariants hold without
      // moving real users between tenants. Per TenantCloneSeeder docs:
      // shells appear in the child tenant's "review needed" admin list.
      //
      // Mapping strategy: stamp the source id into the child's
      // metadata.clonedFromNodeId at insert time, then read it back
      // via RETURNING. The prior implementation JOIN'd on (label,
      // node_type) — but org_nodes has no UNIQUE constraint on
      // (tenant_id, label, node_type), so duplicate labels in the
      // parent produced a Cartesian map and edges silently rewired to
      // the wrong target. The metadata stamp is unique per source
      // row, so the RETURNING is one-to-one regardless of duplicates,
      // AND it leaves an audit trail of provenance on the cloned node.
      const nodes = await client.query<{ old_id: string; new_id: string }>(
        `INSERT INTO oweibo.org_nodes
           (tenant_id, node_type, label, user_id, external_ref, metadata)
         SELECT
           $2::uuid, node_type, label, NULL, external_ref,
           COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('clonedFromNodeId', id::text)
           FROM oweibo.org_nodes
          WHERE tenant_id = $1::uuid
         RETURNING (metadata ->> 'clonedFromNodeId') AS old_id, id::text AS new_id`,
        [parent, child],
      );
      const map = new Map(nodes.rows.map((r) => [r.old_id, r.new_id]));

      // Edges: rewrite from_node + to_node through the id map.
      let edgeCount = 0;
      const edges = await client.query<{
        from_node: string; to_node: string; edge_type: string; metadata: Record<string, unknown>;
      }>(
        `SELECT from_node, to_node, edge_type, metadata
           FROM oweibo.org_edges WHERE tenant_id = $1::uuid`,
        [parent],
      );
      for (const e of edges.rows) {
        const from = map.get(e.from_node);
        const to   = map.get(e.to_node);
        if (!from || !to) continue;
        const r = await client.query(
          `INSERT INTO oweibo.org_edges (tenant_id, from_node, to_node, edge_type, metadata)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)
            ON CONFLICT ON CONSTRAINT org_edges_unique DO NOTHING`,
          [child, from, to, e.edge_type, JSON.stringify(e.metadata)],
        );
        if (r.rowCount && r.rowCount > 0) edgeCount += 1;
      }
      return nodes.rows.length + edgeCount;
    });
  }

  private async copySettings(parent: string, child: string): Promise<number> {
    return this.txPlatform(async (client) => {
      const r = await client.query(
        `UPDATE oweibo.tenants child
            SET features = COALESCE(child.features, '{}'::jsonb)
                         || (parent.features - 'industry'),
                home_region = COALESCE(child.home_region, parent.home_region)
           FROM oweibo.tenants parent
          WHERE child.id  = $2::uuid
            AND parent.id = $1::uuid`,
        [parent, child],
      );
      return r.rowCount ?? 0;
    });
  }

  private async recommendConnectorsFromParent(parent: string, child: string): Promise<number> {
    return this.txPlatform(async (client) => {
      // Insert recommended rows mirroring the parent's installed connectors,
      // status='recommended'. Credentials NEVER transfer — vault_path is
      // rewritten to point at the child's namespace.
      const r = await client.query(
        `INSERT INTO oweibo.tenant_connectors
            (tenant_id, connector_id, catalog_version, instance_label,
             vault_path, status, metadata)
          SELECT $2::uuid, connector_id, catalog_version, instance_label,
                 'oweibo/tenants/' || $2 || '/connectors/' || connector_id || '/' || instance_label,
                 'recommended',
                 jsonb_build_object('clonedFromParent', $1::text)
            FROM oweibo.tenant_connectors
           WHERE tenant_id = $1::uuid
             AND status IN ('active','pending','recommended')
          ON CONFLICT ON CONSTRAINT tenant_connectors_unique_instance DO NOTHING`,
        [parent, child],
      );
      return r.rowCount ?? 0;
    });
  }

  private async txPlatform<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Cross-tenant copy — must run as platform_admin to bypass per-tenant RLS.
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
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
