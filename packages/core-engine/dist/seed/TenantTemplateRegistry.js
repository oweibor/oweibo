"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantTemplateRegistry = void 0;
const DEFAULT_TTL_MS = 60_000;
class TenantTemplateRegistry {
    pool;
    cacheTtlMs;
    now;
    cache = null;
    constructor(pool, opts = {}) {
        this.pool = pool;
        this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
        this.now = opts.now ?? (() => Date.now());
    }
    /** List every active template. Order: 'default' first, then alphabetical. */
    async list() {
        const now = this.now();
        if (this.cache && this.cache.expiresAt > now)
            return this.cache.templates;
        const result = await this.pool.query(`SELECT slug, display_name, description, industries,
              default_features, default_quotas,
              seed_memory_tags, seed_skill_set, goal_template_set,
              active
         FROM oweibo.tenant_templates
        WHERE active = true
        ORDER BY (slug = 'default') DESC, slug ASC`);
        const templates = result.rows.map(toTemplate);
        this.cache = { templates, expiresAt: now + this.cacheTtlMs };
        return templates;
    }
    /** Lookup by slug. Returns null when the slug doesn't exist. */
    async get(slug) {
        const all = await this.list();
        return all.find((t) => t.slug === slug) ?? null;
    }
    /** Drop the in-memory cache. Reserved for tests + admin updates. */
    invalidate() {
        this.cache = null;
    }
}
exports.TenantTemplateRegistry = TenantTemplateRegistry;
function toTemplate(r) {
    return {
        slug: r.slug,
        displayName: r.display_name,
        description: r.description,
        industries: r.industries ?? [],
        defaultFeatures: (r.default_features ?? {}),
        defaultQuotas: (r.default_quotas ?? {}),
        seedMemoryTags: r.seed_memory_tags ?? [],
        seedSkillSet: r.seed_skill_set,
        goalTemplateSet: r.goal_template_set,
        active: r.active,
    };
}
//# sourceMappingURL=TenantTemplateRegistry.js.map