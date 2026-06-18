/**
 * F.5.7 (ttv-finals): PgProjectSeeder adapter.
 *
 * Writes one starter project row per tenant into oweibo.tenant_projects.
 * The spec (name + description + invariants + tags) is supplied by the
 * caller via starterProjectSpec() from StarterProjectTemplates.ts; the
 * adapter just persists.
 *
 * Idempotency: ON CONFLICT (tenant_id, template_slug, name) DO NOTHING.
 * Re-running with the same template returns status='already_present'
 * and projectId of the existing row.
 *
 * The spec.invariants + spec.tags are merged into the spec JSONB column
 * so the project's behavioural data lives in one place; the SQL row's
 * top-level columns (template_slug, name) carry only the natural-key
 * fields.
 */
import type { Pool, PoolClient } from 'pg';

export interface StarterProjectInvariants {
  readonly name: string;
  readonly description: string;
  readonly invariants: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

export type SeederStatus = 'inserted' | 'already_present' | 'failed';

export interface SeedStarterProjectResult {
  readonly projectId: string | null;
  readonly status: SeederStatus;
  readonly reason?: string;
}

export class PgProjectSeeder {
  constructor(private readonly pool: Pool) {}

  /** Insert one starter project row; return `already_present` with the existing id on unique-conflict. */
  async seedStarterProject(
    tenantId: string,
    spec: StarterProjectInvariants,
    templateSlug = 'default',
  ): Promise<SeedStarterProjectResult> {
    return this.tx(tenantId, async (client) => {
      // Attempt insert first.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO oweibo.tenant_projects
            (tenant_id, template_slug, name, spec, state)
          VALUES ($1::uuid, $2, $3, $4::jsonb, 'active')
          ON CONFLICT ON CONSTRAINT tenant_projects_unique_starter DO NOTHING
          RETURNING id`,
        [tenantId, templateSlug, spec.name, JSON.stringify({
          description: spec.description,
          invariants: spec.invariants,
          tags: spec.tags,
        })],
      );
      if (inserted.rows.length > 0) {
        return { projectId: inserted.rows[0]!.id, status: 'inserted' };
      }
      // Look up existing row to return its id.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM oweibo.tenant_projects
          WHERE tenant_id = $1::uuid AND template_slug = $2 AND name = $3`,
        [tenantId, templateSlug, spec.name],
      );
      const projectId = existing.rows[0]?.id ?? null;
      return { projectId, status: 'already_present' };
    });
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
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
