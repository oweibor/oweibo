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

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  templates: readonly TenantTemplate[];
  expiresAt: number;
}

export class TenantTemplateRegistry {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: CacheEntry | null = null;

  constructor(private readonly pool: Pool, opts: TenantTemplateRegistryOptions = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** List every active template. Order: 'default' first, then alphabetical. */
  async list(): Promise<readonly TenantTemplate[]> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.templates;

    const result = await this.pool.query<DbRow>(
      `SELECT slug, display_name, description, industries,
              default_features, default_quotas,
              seed_memory_tags, seed_skill_set, goal_template_set,
              active
         FROM oweibo.tenant_templates
        WHERE active = true
        ORDER BY (slug = 'default') DESC, slug ASC`,
    );
    const templates = result.rows.map(toTemplate);
    this.cache = { templates, expiresAt: now + this.cacheTtlMs };
    return templates;
  }

  /** Lookup by slug. Returns null when the slug doesn't exist. */
  async get(slug: string): Promise<TenantTemplate | null> {
    const all = await this.list();
    return all.find((t) => t.slug === slug) ?? null;
  }

  /** Drop the in-memory cache. Reserved for tests + admin updates. */
  invalidate(): void {
    this.cache = null;
  }
}

interface DbRow {
  slug: string;
  display_name: string;
  description: string;
  industries: string[] | null;
  default_features: unknown;
  default_quotas: unknown;
  seed_memory_tags: string[] | null;
  seed_skill_set: string;
  goal_template_set: string;
  active: boolean;
}

function toTemplate(r: DbRow): TenantTemplate {
  return {
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    industries: r.industries ?? [],
    defaultFeatures: (r.default_features ?? {}) as Readonly<Record<string, unknown>>,
    defaultQuotas: (r.default_quotas ?? {}) as Readonly<Record<string, unknown>>,
    seedMemoryTags: r.seed_memory_tags ?? [],
    seedSkillSet: r.seed_skill_set,
    goalTemplateSet: r.goal_template_set,
    active: r.active,
  };
}
