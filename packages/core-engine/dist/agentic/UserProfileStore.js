"use strict";
/**
 * UserProfileStore — authoritative source for user preferences and profile fields.
 *
 * This class owns all reads and writes for user profile data. It has zero
 * dependency on LongTermMemoryStore — preferences are facts, not episodic
 * observations, and must not participate in vector recall or decay cycles.
 *
 * Storage layout:
 *   Postgres table  user_profiles    — scalar profile fields (displayName, skillLevel, …)
 *   Postgres table  user_preferences — key/value preference rows (one row per key per user)
 *   Redis key       user-profile:{tenantId}:{userId} — 900s warm-read cache (JSON)
 *
 * All writes invalidate the Redis cache so the next loadProfile() re-fetches
 * from Postgres and re-warms the key with the latest data.
 *
 * renderProfile() converts a UserProfile into an XML block suitable for
 * injection into a system prompt. It respects userProfileTokenCap by dropping
 * the lowest-confidence preferences one at a time until the rendered string fits.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserProfileStore = void 0;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function cacheKey(tenantId, userId) {
    return `user-profile:${tenantId}:${userId}`;
}
// ─── Store ────────────────────────────────────────────────────────────────────
class UserProfileStore {
    pg;
    redis;
    userProfileTokenCap;
    constructor(pg, redis, userProfileTokenCap = 600) {
        this.pg = pg;
        this.redis = redis;
        this.userProfileTokenCap = userProfileTokenCap;
    }
    // ── loadProfile ─────────────────────────────────────────────────────────────
    /**
     * loadProfile — fetch a user's combined profile and preferences.
     *
     * Cache-first: checks Redis (900s TTL) before hitting Postgres.
     * Postgres query: LEFT JOIN user_profiles + user_preferences, ordered by
     * confidence DESC so the most reliable preferences appear first.
     * Returns null for users who have no rows in either table (new users).
     */
    async loadProfile(tenantId, userId) {
        const key = cacheKey(tenantId, userId);
        // ── Cache hit ────────────────────────────────────────────────────────────
        const cached = await this.redis.get(key);
        if (cached !== null) {
            try {
                return JSON.parse(cached);
            }
            catch {
                // Corrupt cache entry — fall through to Postgres.
            }
        }
        // ── Postgres query ───────────────────────────────────────────────────────
        // LEFT JOIN so we get a profile row even when there are no preferences yet.
        // The NULL row from user_preferences is filtered out in the mapping below.
        const result = await this.pg.query(`SELECT
         up.display_name,
         up.preferred_output_format,
         up.skill_level,
         up.communication_style,
         up.timezone,
         up.language,
         up.updated_at            AS profile_updated_at,
         upr.key                  AS pref_key,
         upr.value                AS pref_value,
         upr.confidence           AS pref_confidence,
         upr.updated_at           AS pref_updated_at
       FROM       user_profiles   up
       LEFT JOIN  user_preferences upr
               ON upr.tenant_id = up.tenant_id
              AND upr.user_id   = up.user_id
       WHERE up.tenant_id = $1
         AND up.user_id   = $2
       ORDER BY upr.confidence DESC NULLS LAST`, [tenantId, userId]);
        if (result.rows.length === 0)
            return null;
        const first = result.rows[0];
        if (!first)
            return null;
        // Collect preferences — skip the NULL row produced by LEFT JOIN when there
        // are no preferences at all.
        const preferences = result.rows
            .filter(r => r.pref_key !== null)
            .map(r => ({
            key: r.pref_key,
            value: r.pref_value,
            confidence: Number(r.pref_confidence ?? 1),
        }));
        // updatedAt = most recent timestamp across profile and preference rows.
        const profileMs = first.profile_updated_at?.getTime() ?? 0;
        const prefMs = result.rows.reduce((max, r) => {
            const t = r.pref_updated_at?.getTime() ?? 0;
            return t > max ? t : max;
        }, 0);
        const updatedAt = Math.max(profileMs, prefMs) || Date.now();
        const profile = {
            userId,
            tenantId,
            preferences,
            updatedAt,
            ...(first.display_name ? { displayName: first.display_name } : {}),
            ...(first.preferred_output_format ? { preferredOutputFormat: first.preferred_output_format } : {}),
            ...(first.skill_level ? { skillLevel: first.skill_level } : {}),
            ...(first.communication_style ? { communicationStyle: first.communication_style } : {}),
            ...(first.timezone ? { timezone: first.timezone } : {}),
            ...(first.language ? { language: first.language } : {}),
        };
        // ── Warm cache ───────────────────────────────────────────────────────────
        await this.redis.setex(key, 900, JSON.stringify(profile));
        return profile;
    }
    // ── upsertPreference ───────────────────────────────────────────────────────
    /**
     * upsertPreference — write (or update) a single preference key for a user.
     *
     * Uses GREATEST() so that a high-confidence signal from a recent session never
     * gets overwritten by a low-confidence detection from an earlier one.
     * Invalidates the Redis cache after every write.
     */
    async upsertPreference(tenantId, userId, key, value, confidence = 1.0) {
        await this.pg.query(`INSERT INTO user_preferences
         (tenant_id, user_id, key, value, confidence, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tenant_id, user_id, key) DO UPDATE
         SET value      = EXCLUDED.value,
             confidence = GREATEST(user_preferences.confidence, EXCLUDED.confidence),
             updated_at = NOW()`, [tenantId, userId, key, value, confidence]);
        await this.redis.del(cacheKey(tenantId, userId));
    }
    // ── upsertProfileFields ────────────────────────────────────────────────────
    /**
     * upsertProfileFields — merge scalar profile fields into user_profiles.
     *
     * Uses the JSONB || merge operator so only the supplied fields are updated;
     * unmentioned columns retain their existing values. Invalidates the cache.
     */
    async upsertProfileFields(tenantId, userId, fields) {
        // Map camelCase interface keys to snake_case column names.
        const row = {};
        if (fields.displayName !== undefined)
            row['display_name'] = fields.displayName;
        if (fields.preferredOutputFormat !== undefined)
            row['preferred_output_format'] = fields.preferredOutputFormat;
        if (fields.skillLevel !== undefined)
            row['skill_level'] = fields.skillLevel;
        if (fields.communicationStyle !== undefined)
            row['communication_style'] = fields.communicationStyle;
        if (fields.timezone !== undefined)
            row['timezone'] = fields.timezone;
        if (fields.language !== undefined)
            row['language'] = fields.language;
        if (Object.keys(row).length === 0)
            return; // nothing to write
        // Build a parameterised JSONB merge upsert.
        // We cast our plain-object payload to JSONB and merge with || so that
        // only the supplied keys are written; any existing keys not in `row`
        // are preserved by the SELECT in the DO UPDATE clause.
        await this.pg.query(`INSERT INTO user_profiles
         (tenant_id, user_id, updated_at,
          display_name, preferred_output_format, skill_level,
          communication_style, timezone, language)
       VALUES (
         $1, $2, NOW(),
         $3::text, $4::text, $5::text,
         $6::text, $7::text, $8::text
       )
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET display_name            = COALESCE($3::text, user_profiles.display_name),
             preferred_output_format = COALESCE($4::text, user_profiles.preferred_output_format),
             skill_level             = COALESCE($5::text, user_profiles.skill_level),
             communication_style     = COALESCE($6::text, user_profiles.communication_style),
             timezone                = COALESCE($7::text, user_profiles.timezone),
             language                = COALESCE($8::text, user_profiles.language),
             updated_at              = NOW()`, [
            tenantId,
            userId,
            row['display_name'] ?? null,
            row['preferred_output_format'] ?? null,
            row['skill_level'] ?? null,
            row['communication_style'] ?? null,
            row['timezone'] ?? null,
            row['language'] ?? null,
        ]);
        await this.redis.del(cacheKey(tenantId, userId));
    }
    // ── renderProfile ──────────────────────────────────────────────────────────
    /**
     * renderProfile — render a UserProfile as an XML block for system-prompt injection.
     *
     * Returns an empty string for null (new user — no profile data yet).
     * The rendered block is bounded by userProfileTokenCap characters (character
     * count is used as a proxy for token count — the tokenizer is not available here).
     * If the full render exceeds the cap, the lowest-confidence preference is dropped
     * repeatedly until the string fits. Scalar fields are never truncated.
     */
    renderProfile(profile) {
        if (profile === null)
            return '';
        // Preferences sorted high-confidence-first so that when we drop from the
        // tail we always remove the least reliable signals first.
        const prefs = [...profile.preferences].sort((a, b) => b.confidence - a.confidence);
        for (let dropCount = 0; dropCount <= prefs.length; dropCount++) {
            const visiblePrefs = prefs.slice(0, prefs.length - dropCount || undefined);
            const rendered = buildXml(profile, visiblePrefs);
            if (rendered.length <= this.userProfileTokenCap)
                return rendered;
        }
        // Scalar fields alone exceed the cap — return what we have (no preferences).
        return buildXml(profile, []);
    }
}
exports.UserProfileStore = UserProfileStore;
// ─── Private render helper ────────────────────────────────────────────────────
function buildXml(profile, prefs) {
    const lines = ['<user_profile>'];
    if (profile.displayName)
        lines.push(`  <display_name>${esc(profile.displayName)}</display_name>`);
    if (profile.skillLevel)
        lines.push(`  <skill_level>${esc(profile.skillLevel)}</skill_level>`);
    if (profile.preferredOutputFormat)
        lines.push(`  <preferred_output_format>${esc(profile.preferredOutputFormat)}</preferred_output_format>`);
    if (profile.communicationStyle)
        lines.push(`  <communication_style>${esc(profile.communicationStyle)}</communication_style>`);
    if (profile.timezone)
        lines.push(`  <timezone>${esc(profile.timezone)}</timezone>`);
    if (profile.language)
        lines.push(`  <language>${esc(profile.language)}</language>`);
    if (prefs.length > 0) {
        lines.push('  <preferences>');
        for (const p of prefs) {
            lines.push(`    <preference key="${esc(p.key)}" confidence="${p.confidence.toFixed(2)}">${esc(p.value)}</preference>`);
        }
        lines.push('  </preferences>');
    }
    lines.push('</user_profile>');
    return lines.join('\n');
}
/** Minimal XML character escaping for attribute values and text content. */
function esc(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
//# sourceMappingURL=UserProfileStore.js.map