/**
 * F.5.4 (ttv-finals): PgOrgGraphSeederAdapter.
 *
 * Bridges the bootstrap-worker's IOrgGraphSeeder shape to the existing
 * OrgGraphSeeder service (core-engine/src/org). Resolution of the
 * creating user happens here: query oweibo.tenant_memberships for the
 * earliest invited_at row with role 'tenant_admin' (or any admin role
 * if no tenant_admin exists). If no membership exists, the org graph is
 * still seeded with the admin team + council nodes — no creator person
 * node is added.
 *
 * Edge: tenant with 0 members → creates the admin-team + council nodes
 * only (per plan §F.5.4 "Edge: tenant with 0 members → creates
 * tenant-root node only" generalised to this implementation).
 */
import type { Pool } from 'pg';
import { OrgGraphSeeder } from '../../org/OrgGraphSeeder.js';
import type { OrgGraphService } from '../../org/OrgGraphService.js';

export interface OrgGraphSeedResult {
  readonly creatorNodeId: string | null;
  readonly adminTeamNodeId: string | null;
  readonly councilNodeId: string | null;
  readonly nodesCreated: number;
  readonly edgesCreated: number;
}

export class PgOrgGraphSeederAdapter {
  private readonly inner: OrgGraphSeeder;

  constructor(
    private readonly pool: Pool,
    orgService: OrgGraphService,
  ) {
    this.inner = new OrgGraphSeeder(orgService);
  }

  async seed(tenantId: string): Promise<OrgGraphSeedResult> {
    const creatorUserId = await this.findCreatingUser(tenantId);
    return this.inner.seed({ tenantId, creatorUserId });
  }

  /**
   * Earliest-invited member with an admin-flavoured role. Falls back to
   * the earliest membership regardless of role, then to null.
   *
   * Runs under platform_admin to bypass RLS — this lookup happens at
   * worker boot of the bootstrap pipeline, before app.tenant_id is set.
   */
  private async findCreatingUser(tenantId: string): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
      // Prefer a tenant_admin / admin role; fall back to earliest member.
      const adminRow = await client.query<{ user_id: string }>(
        `SELECT user_id
           FROM oweibo.tenant_memberships
          WHERE tenant_id = $1::uuid
            AND (roles && ARRAY['tenant_admin','admin','owner']::text[])
          ORDER BY invited_at ASC
          LIMIT 1`,
        [tenantId],
      );
      if (adminRow.rows[0]) return adminRow.rows[0].user_id;

      const anyRow = await client.query<{ user_id: string }>(
        `SELECT user_id FROM oweibo.tenant_memberships
          WHERE tenant_id = $1::uuid
          ORDER BY invited_at ASC LIMIT 1`,
        [tenantId],
      );
      return anyRow.rows[0]?.user_id ?? null;
    } finally {
      client.release();
    }
  }
}
