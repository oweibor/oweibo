/**
 * T.2.a: PlatformSeedCatalog — registry of platform-curated seed memories.
 *
 * The catalog is loaded from versioned JSON files at startup; entries are
 * filtered per tenant by `applicableTo.templates` and `applicableTo.industries`.
 * SeedMemoriesStep iterates the filtered set and calls IMemoryOrchestrator.
 *
 * Each entry has a stable `seedId` so re-runs are idempotent — the bootstrap
 * step checks the tenant's collection for an existing `seed:<seedId>` tag and
 * skips already-installed entries. A `catalogVersion` bump signals that an
 * entry's content has changed; T.7 will own the upgrade path.
 *
 * Catalog files live next to this module at `./seed-memories/*.json` and ship
 * as part of the package's `dist/seed/seed-memories` tree.
 */
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import type { MemoryKind } from '@oweibo/core-contracts';

export interface PlatformSeedMemory {
  readonly seedId: string;
  readonly catalogVersion: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly body?: string;
  /** 0..1 — capped at 0.6 by convention so organic memories can outrank. */
  readonly importance: number;
  readonly tags: readonly string[];
  readonly applicableTo: {
    /** Template slugs that should receive this seed. `'*'` = all tenants. */
    readonly templates: readonly string[];
    readonly industries?: readonly string[];
    /**
     * T.8: optional region filter. Accepts concrete regions (`us-east-1`),
     * region globs (`us-*`, `eu-*`), or the neutral marker `*`. Omitted /
     * empty = region-agnostic (today's behaviour).
     */
    readonly regions?: readonly string[];
  };
  /**
   * T.7: SHA-256 of the canonical seed payload — kind, summary, body,
   * importance, and the *non-marker* tags. Excludes catalogVersion so a
   * pure version-string bump does not look like a content revision. Set by
   * normalize(); callers that construct an entry manually do not need to
   * supply it.
   */
  readonly contentHash: string;
}

export interface CatalogFilter {
  readonly templateSlug: string;
  readonly industry?: string;
  /** T.8: tenant home_region. When supplied, applicableTo.regions is consulted. */
  readonly homeRegion?: string;
}

const IMPORTANCE_CAP = 0.6;

export class PlatformSeedCatalog {
  private constructor(private readonly entries: readonly PlatformSeedMemory[]) {}

  /**
   * Load the catalog from a directory of JSON files. Files are expected to be
   * objects of shape `{ entries: PlatformSeedMemory[] }` — one file per
   * MemoryKind for review tractability, but the runtime only sees the merged
   * array. Throws on parse error: a bad catalog should fail the worker, not
   * silently ship empty data.
   */
  static async loadFromDirectory(dir: string): Promise<PlatformSeedCatalog> {
    const files = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    const all: PlatformSeedMemory[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) {
        throw new Error(`PlatformSeedCatalog: ${f} missing entries[]`);
      }
      for (const e of parsed.entries) {
        validateEntry(e, f);
        all.push(normalize(e as PlatformSeedMemory));
      }
    }
    assertSeedIdsUnique(all);
    return new PlatformSeedCatalog(all);
  }

  /** Construct from an in-memory list. Used by tests. */
  static fromEntries(entries: readonly PlatformSeedMemory[]): PlatformSeedCatalog {
    assertSeedIdsUnique(entries);
    return new PlatformSeedCatalog(entries.map(normalize));
  }

  /**
   * Default catalog directory shipped alongside this module. Tests pass an
   * explicit directory to `loadFromDirectory`; production callers can use
   * this helper. Resolves to `src/seed/seed-memories` in test (ts-jest sees
   * __dirname under src) and `dist/seed/seed-memories` at runtime.
   */
  static defaultDirectory(): string {
    return path.join(__dirname, 'seed-memories');
  }

  /** Filter entries that apply to the given tenant context. */
  forTenant(filter: CatalogFilter): PlatformSeedMemory[] {
    return this.entries.filter((e) => {
      const templates = e.applicableTo.templates;
      if (!templates.includes('*') && !templates.includes(filter.templateSlug)) return false;
      const industries = e.applicableTo.industries;
      if (industries && industries.length > 0) {
        if (!filter.industry) return false;
        if (!industries.includes(filter.industry)) return false;
      }
      // T.8: region filter. Only applied when the caller passes homeRegion;
      // when omitted, region-tagged entries match too (preserves the byte-
      // identical-to-today behaviour when the region_aware_intake flag is
      // off, since the caller simply doesn't pass homeRegion in that case).
      const regions = e.applicableTo.regions;
      if (regions && regions.length > 0 && filter.homeRegion !== undefined) {
        if (!regionMatches(regions, filter.homeRegion)) return false;
      }
      return true;
    });
  }

  /** Total number of loaded entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Returns the full set — used by tests. */
  all(): readonly PlatformSeedMemory[] {
    return this.entries;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function validateEntry(e: unknown, source: string): asserts e is PlatformSeedMemory {
  if (!e || typeof e !== 'object') {
    throw new Error(`PlatformSeedCatalog: ${source} contains a non-object entry`);
  }
  const o = e as Record<string, unknown>;
  for (const k of ['seedId', 'catalogVersion', 'kind', 'summary'] as const) {
    if (typeof o[k] !== 'string' || o[k] === '') {
      throw new Error(`PlatformSeedCatalog: ${source} entry missing required string field ${k}`);
    }
  }
  if (typeof o.importance !== 'number' || o.importance < 0 || o.importance > 1) {
    throw new Error(`PlatformSeedCatalog: ${source} entry has invalid importance (must be 0..1)`);
  }
  if (!Array.isArray(o.tags)) {
    throw new Error(`PlatformSeedCatalog: ${source} entry has invalid tags (must be array)`);
  }
  const at = o.applicableTo as Record<string, unknown> | undefined;
  if (!at || !Array.isArray(at.templates)) {
    throw new Error(`PlatformSeedCatalog: ${source} entry has invalid applicableTo.templates`);
  }
}

function normalize(e: PlatformSeedMemory): PlatformSeedMemory {
  const importance = Math.min(IMPORTANCE_CAP, Math.max(0, e.importance));
  // Always ensure the seed-marker tags are present and de-duplicated.
  const seedMarker = `seed:${e.seedId}`;
  const versionMarker = `seed:catalog:${e.catalogVersion}`;
  // Hash the *non-marker* tags so re-running normalize() doesn't change the
  // hash (otherwise loading the same entry twice would produce different
  // marker sets and rotating hashes).
  const nonMarkerTags = [...e.tags].filter(
    (t) => !t.startsWith('seed:'),
  );
  const tagSet = new Set<string>([...e.tags, seedMarker, versionMarker]);
  return {
    ...e,
    importance,
    tags: Array.from(tagSet),
    contentHash: computeContentHash({
      kind: e.kind,
      summary: e.summary,
      body: e.body,
      importance,
      tags: nonMarkerTags,
    }),
  };
}

/**
 * T.7: deterministic content hash for a seed payload. Canonical serialisation
 * sorts the tags array so two callers that supply the same logical content
 * in different tag order get the same hash. Excludes catalogVersion so a
 * pure version-string bump does not look like a content revision.
 */
export function computeContentHash(payload: {
  readonly kind: string;
  readonly summary: string;
  readonly body?: string;
  readonly importance: number;
  readonly tags: readonly string[];
}): string {
  const canonical = JSON.stringify({
    kind: payload.kind,
    summary: payload.summary,
    body: payload.body ?? null,
    importance: payload.importance,
    tags: [...payload.tags].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function assertSeedIdsUnique(entries: readonly PlatformSeedMemory[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.seedId)) {
      throw new Error(`PlatformSeedCatalog: duplicate seedId ${e.seedId}`);
    }
    seen.add(e.seedId);
  }
}

/**
 * T.8: match a catalog entry's `applicableRegions` against the tenant's
 * home_region. Kept here (not via RegionResolver import) to keep this
 * module dependency-light — the matching rules are intentionally tiny.
 *
 *  - `*` always matches.
 *  - Exact match: `applicableRegion` equals `homeRegion`.
 *  - Glob match: `applicableRegion` ends in `-*` and homeRegion has the
 *    same prefix (e.g. `eu-*` matches `eu-central-1`).
 */
function regionMatches(
  applicableRegions: readonly string[],
  homeRegion: string | undefined,
): boolean {
  for (const r of applicableRegions) {
    if (r === '*') return true;
    if (!homeRegion) continue;
    if (r === homeRegion) return true;
    if (r.endsWith('-*')) {
      const prefix = r.slice(0, -1); // 'eu-*' → 'eu-'
      if (homeRegion.startsWith(prefix)) return true;
    }
  }
  return false;
}
