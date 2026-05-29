/**
 * F.1.8 — PgTenantDomainBindingLookup.
 *
 * Pg-backed implementation of the `TenantDomainLookup` seam exposed by
 * ComplianceRulePackRegistry. Reads `oweibo.tenant_domain_binding` (D.6
 * migration) and returns the domain slugs the tenant is currently bound
 * to, ordered by role (primary first, then secondary) then by weight DESC.
 *
 * Wiring into ComplianceRulePackRegistry (typically in main.ts):
 *
 *   const lookup = new PgTenantDomainBindingLookup(pgPool);
 *   const registry = new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
 *     tenantDomainLookup: (t) => lookup.forTenant(t),
 *   });
 *
 * Cache
 * ─────
 * 60 s in-process TTL. Cache invalidation is wired through invalidate();
 * the admin-web binding-edit endpoint (F.4.5) calls it on PUT, and a
 * Redis-NOTIFY listener (out of scope here) can call it on cross-pod
 * propagation.
 *
 * Plan note on `compliance_rule_packs` table
 * ──────────────────────────────────────────
 * The earlier plan draft assumed an `oweibo.compliance_rule_packs` table
 * shipped with the D.3 migration; it did not — D.3 only created
 * `compliance_rule_evaluations`. Packs themselves remain TypeScript
 * (V1_COMPLIANCE_RULE_PACKS in ComplianceRulePackRegistry.ts), deployed
 * atomically as code. Per-tenant variability — which domains a tenant is
 * bound to — lives in `tenant_domain_binding`, which this lookup wraps.
 * If a packs-as-rows model is required later, this lookup stays correct;
 * a separate PgComplianceRulePackStore would augment it.
 */
import type { Pool, PoolClient } from 'pg';
import type { DomainSlug } from '@oweibo/core-contracts';

const UUID_RE = /^[0-9a-f-]{36}$/i;

export interface PgTenantDomainBindingLookupOptions {
  /** TTL in ms. Default 60_000. */
  readonly cacheTtlMs?: number;
  /** Override clock; tests pin time. */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly slugs: readonly DomainSlug[];
  readonly ts: number;
}

export class PgTenantDomainBindingLookup {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly pool: Pool,
    opts: PgTenantDomainBindingLookupOptions = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Resolve the domain slugs a tenant is bound to.
   *
   * Ordering: primary role first, then secondary, weight DESC within each.
   * Returns [] when the tenant has no bindings; never throws on missing-
   * tenant — RLS hides it, and the result is [].
   *
   * On DB error: propagates (callers cache misses are not a fail-closed
   * concern for this read; the upstream registry already falls back to
   * `defaultDomains` on lookup throw).
   */
  async forTenant(tenantId: string): Promise<readonly DomainSlug[]> {
    if (!UUID_RE.test(tenantId)) return [];
    const hit = this.cache.get(tenantId);
    if (hit && this.now() - hit.ts < this.cacheTtlMs) return hit.slugs;

    const slugs = await this.loadFromDb(tenantId);
    this.cache.set(tenantId, { slugs, ts: this.now() });
    return slugs;
  }

  /** Drop the cached entry for tenantId. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Drop every cached entry. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private async loadFromDb(tenantId: string): Promise<readonly DomainSlug[]> {
    return withTenantClient(this.pool, tenantId, async (client) => {
      const r = await client.query<{ domain_slug: string }>(
        `SELECT domain_slug
           FROM oweibo.tenant_domain_binding
          WHERE tenant_id = $1::uuid
          ORDER BY
            CASE role WHEN 'primary' THEN 0 ELSE 1 END,
            weight DESC,
            domain_slug ASC`,
        [tenantId],
      );
      return r.rows.map((row) => row.domain_slug as DomainSlug);
    });
  }
}

async function withTenantClient<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
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
