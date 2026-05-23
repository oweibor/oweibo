"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformSeedCatalog = void 0;
exports.computeContentHash = computeContentHash;
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
const fs_1 = require("fs");
const crypto_1 = require("crypto");
const path = __importStar(require("path"));
const IMPORTANCE_CAP = 0.6;
class PlatformSeedCatalog {
    entries;
    constructor(entries) {
        this.entries = entries;
    }
    /**
     * Load the catalog from a directory of JSON files. Files are expected to be
     * objects of shape `{ entries: PlatformSeedMemory[] }` — one file per
     * MemoryKind for review tractability, but the runtime only sees the merged
     * array. Throws on parse error: a bad catalog should fail the worker, not
     * silently ship empty data.
     */
    static async loadFromDirectory(dir) {
        const files = await fs_1.promises.readdir(dir).catch((err) => {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        });
        const all = [];
        for (const f of files) {
            if (!f.endsWith('.json'))
                continue;
            const raw = await fs_1.promises.readFile(path.join(dir, f), 'utf-8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed.entries)) {
                throw new Error(`PlatformSeedCatalog: ${f} missing entries[]`);
            }
            for (const e of parsed.entries) {
                validateEntry(e, f);
                all.push(normalize(e));
            }
        }
        assertSeedIdsUnique(all);
        return new PlatformSeedCatalog(all);
    }
    /** Construct from an in-memory list. Used by tests. */
    static fromEntries(entries) {
        assertSeedIdsUnique(entries);
        return new PlatformSeedCatalog(entries.map(normalize));
    }
    /**
     * Default catalog directory shipped alongside this module. Tests pass an
     * explicit directory to `loadFromDirectory`; production callers can use
     * this helper. Resolves to `src/seed/seed-memories` in test (ts-jest sees
     * __dirname under src) and `dist/seed/seed-memories` at runtime.
     */
    static defaultDirectory() {
        return path.join(__dirname, 'seed-memories');
    }
    /** Filter entries that apply to the given tenant context. */
    forTenant(filter) {
        return this.entries.filter((e) => {
            const templates = e.applicableTo.templates;
            if (!templates.includes('*') && !templates.includes(filter.templateSlug))
                return false;
            const industries = e.applicableTo.industries;
            if (industries && industries.length > 0) {
                if (!filter.industry)
                    return false;
                if (!industries.includes(filter.industry))
                    return false;
            }
            return true;
        });
    }
    /** Total number of loaded entries. */
    get size() {
        return this.entries.length;
    }
    /** Returns the full set — used by tests. */
    all() {
        return this.entries;
    }
}
exports.PlatformSeedCatalog = PlatformSeedCatalog;
// ── Helpers ───────────────────────────────────────────────────────────────
function validateEntry(e, source) {
    if (!e || typeof e !== 'object') {
        throw new Error(`PlatformSeedCatalog: ${source} contains a non-object entry`);
    }
    const o = e;
    for (const k of ['seedId', 'catalogVersion', 'kind', 'summary']) {
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
    const at = o.applicableTo;
    if (!at || !Array.isArray(at.templates)) {
        throw new Error(`PlatformSeedCatalog: ${source} entry has invalid applicableTo.templates`);
    }
}
function normalize(e) {
    const importance = Math.min(IMPORTANCE_CAP, Math.max(0, e.importance));
    // Always ensure the seed-marker tags are present and de-duplicated.
    const seedMarker = `seed:${e.seedId}`;
    const versionMarker = `seed:catalog:${e.catalogVersion}`;
    // Hash the *non-marker* tags so re-running normalize() doesn't change the
    // hash (otherwise loading the same entry twice would produce different
    // marker sets and rotating hashes).
    const nonMarkerTags = [...e.tags].filter((t) => !t.startsWith('seed:'));
    const tagSet = new Set([...e.tags, seedMarker, versionMarker]);
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
function computeContentHash(payload) {
    const canonical = JSON.stringify({
        kind: payload.kind,
        summary: payload.summary,
        body: payload.body ?? null,
        importance: payload.importance,
        tags: [...payload.tags].sort(),
    });
    return (0, crypto_1.createHash)('sha256').update(canonical).digest('hex');
}
function assertSeedIdsUnique(entries) {
    const seen = new Set();
    for (const e of entries) {
        if (seen.has(e.seedId)) {
            throw new Error(`PlatformSeedCatalog: duplicate seedId ${e.seedId}`);
        }
        seen.add(e.seedId);
    }
}
//# sourceMappingURL=PlatformSeedCatalog.js.map