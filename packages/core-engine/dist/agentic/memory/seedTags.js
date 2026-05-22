"use strict";
/**
 * T.2.a: shared predicates over platform-curated seed tags.
 *
 * Seed entries carry a `seed:<id>` tag plus a `seed:catalog:<version>` tag,
 * and may additionally carry `seed:suppressed:<reason>` when the per-tenant
 * feedback worker decides to suppress them. The three predicates below are
 * imported by MemoryDecayService, MemoryConsolidator, and MemoryWarmer so
 * the behavior is consistent across services.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSeedTagged = isSeedTagged;
exports.isSuppressedSeedTagged = isSuppressedSeedTagged;
/** True if any tag starts with `seed:` — a platform-curated seed entry. */
function isSeedTagged(tags) {
    if (!tags || tags.length === 0)
        return false;
    for (const t of tags) {
        if (typeof t === 'string' && t.startsWith('seed:'))
            return true;
    }
    return false;
}
/** True if any tag starts with `seed:suppressed:` — exclude from recall. */
function isSuppressedSeedTagged(tags) {
    if (!tags || tags.length === 0)
        return false;
    for (const t of tags) {
        if (typeof t === 'string' && t.startsWith('seed:suppressed:'))
            return true;
    }
    return false;
}
//# sourceMappingURL=seedTags.js.map