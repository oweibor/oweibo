/**
 * T.6: TenantTemplateRegistry — reads platform-curated tenant templates
 * from oweibo.tenant_templates and serves them to:
 *   - the admin UI dropdown at tenant-create time
 *   - the bootstrap pipeline (which uses the slug to filter seed memories,
 *     skills, goal templates, connectors, and bandit priors)
 *
 * Read-only against the DB; writes flow through SQL / a future admin form.
 *
 * The registry caches results in-process for 60 s — templates change
 * rarely (operator action only) and the cold-path lookup is on the tenant
 * create path. A short TTL absorbs admin-form updates without operator
 * action.
 */
import type { Pool } from 'pg';
export interface TenantTemplate {
    readonly slug: string;
    readonly displayName: string;
    readonly description: string;
    readonly industries: readonly string[];
    readonly defaultFeatures: Readonly<Record<string, unknown>>;
    readonly defaultQuotas: Readonly<Record<string, unknown>>;
    readonly seedMemoryTags: readonly string[];
    readonly seedSkillSet: string;
    readonly goalTemplateSet: string;
    readonly active: boolean;
}
export interface TenantTemplateRegistryOptions {
    /** TTL for the in-process cache in ms. Default 60_000. */
    cacheTtlMs?: number;
    /** Override the clock; tests pin time. */
    now?: () => number;
}
export declare class TenantTemplateRegistry {
    private readonly pool;
    private readonly cacheTtlMs;
    private readonly now;
    private cache;
    constructor(pool: Pool, opts?: TenantTemplateRegistryOptions);
    /** List every active template. Order: 'default' first, then alphabetical. */
    list(): Promise<readonly TenantTemplate[]>;
    /** Lookup by slug. Returns null when the slug doesn't exist. */
    get(slug: string): Promise<TenantTemplate | null>;
    /** Drop the in-memory cache. Reserved for tests + admin updates. */
    invalidate(): void;
}
//# sourceMappingURL=TenantTemplateRegistry.d.ts.map