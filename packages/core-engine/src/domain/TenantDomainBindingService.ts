/**
 * D.6 (domain-depth): TenantDomainBindingService — read/write surface
 * over `oweibo.tenant_domain_binding`.
 *
 * Write path: `replaceBindings(tenantId, bindings[])` is the only
 * mutation API. It performs the full-set replacement atomically in a
 * single transaction (DELETE all rows for tenant, INSERT supplied
 * rows). Single-binding deletes go through this same path with the
 * remaining set supplied. Empty set is permitted (a tenant can be
 * unbound) but the soft cap is enforced unless `force=true`.
 *
 * Read path: `listBindings` normalises raw weights so the returned
 * `weight` field sums to 1.0 across the tenant's bindings (when at
 * least one binding exists). Raw weights are still surfaced as
 * `rawWeight` for admin UIs that want to show the DB values.
 *
 * Integration: `lookupForResolver(tenantId)` returns just the slug list,
 * matching the seam used by D.2 RubricResolver and D.3
 * ComplianceRulePackRegistry. Pass `service.lookupForResolver.bind(service)`
 * as the `tenantDomainLookup` option to either of those.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  DomainSlug,
  TenantDomainBinding,
  TenantDomainBindingInput,
  TenantDomainBindingRole,
  TenantDomainBindingSource,
} from '@oweibo/core-contracts';
import { TENANT_DOMAIN_BINDING_SOFT_CAP } from '@oweibo/core-contracts';

export interface TenantDomainBindingServiceOptions {
  /** Default 'platform_admin' — write operations need elevated scope. */
  setLocalRole?: () => string;
  now?: () => Date;
}

export interface ReplaceBindingsInput {
  readonly tenantId: string;
  readonly bindings: readonly TenantDomainBindingInput[];
  /** Bypass the soft cap (TENANT_DOMAIN_BINDING_SOFT_CAP, default 3). */
  readonly force?: boolean;
}

export class TenantDomainBindingService {
  private readonly roleName: () => string;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: TenantDomainBindingServiceOptions = {}) {
    this.roleName = opts.setLocalRole ?? (() => 'platform_admin');
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Atomic full-set replacement. Validates:
   *   1. at most one primary
   *   2. all weights in [0, 1]
   *   3. no duplicate slugs
   *   4. cardinality <= soft cap unless `force = true`
   *   5. every domain_slug exists in oweibo.domain_registry
   *
   * An empty `bindings` array unbinds the tenant entirely — permitted.
   */
  async replaceBindings(input: ReplaceBindingsInput): Promise<readonly TenantDomainBinding[]> {
    validateInput(input);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client, input.tenantId);

      // Audit-fix: reject unknown domain slugs up-front. A typo or stale
      // slug would otherwise create a binding that no rubric resolver
      // or rule pack ever matches — silent dead-binding.
      if (input.bindings.length > 0) {
        const slugs = input.bindings.map((b) => b.domainSlug);
        const r = await client.query<{ slug: string }>(
          `SELECT slug FROM oweibo.domain_registry WHERE slug = ANY($1::text[])`,
          [slugs],
        );
        const found = new Set(r.rows.map((row) => row.slug));
        const missing = slugs.filter((s) => !found.has(s));
        if (missing.length > 0) {
          throw new Error(
            `TenantDomainBindingService: unknown domain slug(s) [${missing.join(', ')}]; ` +
            `slugs must be registered in oweibo.domain_registry`,
          );
        }
      }

      await client.query(
        `DELETE FROM oweibo.tenant_domain_binding WHERE tenant_id = $1::uuid`,
        [input.tenantId],
      );
      const now = this.now();
      for (const b of input.bindings) {
        await client.query(
          `INSERT INTO oweibo.tenant_domain_binding
             (tenant_id, domain_slug, role, weight, bound_by_type, bound_by_id, confidence, bound_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.tenantId,
            b.domainSlug,
            b.role,
            b.rawWeight,
            b.boundBy.type,
            b.boundBy.id,
            b.confidence ?? null,
            now,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.listBindings(input.tenantId);
  }

  /**
   * Return bindings for the tenant, normalised so `weight` sums to 1.0.
   * `rawWeight` exposes the underlying DB value.
   */
  async listBindings(tenantId: string): Promise<readonly TenantDomainBinding[]> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client, tenantId);
      const r = await client.query<BindingRow>(
        `SELECT tenant_id, domain_slug, role, weight, bound_by_type, bound_by_id, confidence, bound_at
           FROM oweibo.tenant_domain_binding
          WHERE tenant_id = $1::uuid
          ORDER BY role DESC, weight DESC, domain_slug ASC`,
        [tenantId],
      );
      return normaliseBindings(r.rows);
    } finally {
      client.release();
    }
  }

  /** Returns the primary binding's slug or null when none exists. */
  async primaryDomain(tenantId: string): Promise<DomainSlug | null> {
    const bindings = await this.listBindings(tenantId);
    return bindings.find((b) => b.role === 'primary')?.domainSlug ?? null;
  }

  /**
   * The shape consumed by D.2 RubricResolver +
   * D.3 ComplianceRulePackRegistry. Returns slugs only; consumers that
   * need weights call `listBindings` directly.
   */
  async lookupForResolver(tenantId: string): Promise<readonly DomainSlug[]> {
    const bindings = await this.listBindings(tenantId);
    return bindings.map((b) => b.domainSlug);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async setAdminScope(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(`SET LOCAL ROLE ${this.roleName()}`).catch(() => undefined);
    await client.query(`SET LOCAL app.is_platform_admin = 'true'`).catch(() => undefined);
    if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`).catch(() => undefined);
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────

interface BindingRow {
  tenant_id: string;
  domain_slug: string;
  role: TenantDomainBindingRole;
  weight: string | number;
  bound_by_type: TenantDomainBindingSource;
  bound_by_id: string;
  confidence: string | number | null;
  bound_at: Date | string;
}

export function normaliseBindings(rows: readonly BindingRow[]): readonly TenantDomainBinding[] {
  const total = rows.reduce((sum, r) => sum + Number(r.weight), 0);
  return rows.map((r) => {
    const raw = Number(r.weight);
    const normalised = total > 0 ? raw / total : 0;
    return {
      tenantId: r.tenant_id,
      domainSlug: r.domain_slug,
      role: r.role,
      weight: round3(normalised),
      rawWeight: round3(raw),
      boundBy: { type: r.bound_by_type, id: r.bound_by_id },
      confidence: r.confidence === null ? null : Number(r.confidence),
      boundAt: r.bound_at instanceof Date ? r.bound_at.toISOString() : String(r.bound_at),
    };
  });
}

function validateInput(input: ReplaceBindingsInput): void {
  const { bindings, force } = input;
  // Soft cap.
  if (!force && bindings.length > TENANT_DOMAIN_BINDING_SOFT_CAP) {
    throw new Error(
      `TenantDomainBindingService: ${bindings.length} bindings exceeds soft cap ${TENANT_DOMAIN_BINDING_SOFT_CAP}; pass force=true`,
    );
  }
  // Weight range.
  for (const b of bindings) {
    if (!Number.isFinite(b.rawWeight) || b.rawWeight < 0 || b.rawWeight > 1) {
      throw new Error(
        `TenantDomainBindingService: invalid weight ${b.rawWeight} for ${b.domainSlug}`,
      );
    }
  }
  // No duplicate slugs.
  const slugs = new Set<string>();
  for (const b of bindings) {
    if (slugs.has(b.domainSlug)) {
      throw new Error(`TenantDomainBindingService: duplicate slug ${b.domainSlug}`);
    }
    slugs.add(b.domainSlug);
  }
  // At most one primary.
  const primaries = bindings.filter((b) => b.role === 'primary');
  if (primaries.length > 1) {
    throw new Error(
      `TenantDomainBindingService: more than one primary binding (${primaries.length})`,
    );
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
