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
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
export interface UserPreference {
    key: string;
    value: string;
    confidence: number;
}
export interface UserProfile {
    userId: string;
    tenantId: string;
    displayName?: string;
    preferredOutputFormat?: 'concise' | 'verbose' | 'structured';
    skillLevel?: 'beginner' | 'intermediate' | 'expert';
    communicationStyle?: 'formal' | 'casual';
    timezone?: string;
    language?: string;
    preferences: UserPreference[];
    updatedAt: number;
}
export declare class UserProfileStore {
    private readonly pg;
    private readonly redis;
    private readonly userProfileTokenCap;
    constructor(pg: Pool, redis: Redis, userProfileTokenCap?: number);
    /**
     * loadProfile — fetch a user's combined profile and preferences.
     *
     * Cache-first: checks Redis (900s TTL) before hitting Postgres.
     * Postgres query: LEFT JOIN user_profiles + user_preferences, ordered by
     * confidence DESC so the most reliable preferences appear first.
     * Returns null for users who have no rows in either table (new users).
     */
    loadProfile(tenantId: string, userId: string): Promise<UserProfile | null>;
    /**
     * upsertPreference — write (or update) a single preference key for a user.
     *
     * Uses GREATEST() so that a high-confidence signal from a recent session never
     * gets overwritten by a low-confidence detection from an earlier one.
     * Invalidates the Redis cache after every write.
     */
    upsertPreference(tenantId: string, userId: string, key: string, value: string, confidence?: number): Promise<void>;
    /**
     * upsertProfileFields — merge scalar profile fields into user_profiles.
     *
     * Uses the JSONB || merge operator so only the supplied fields are updated;
     * unmentioned columns retain their existing values. Invalidates the cache.
     */
    upsertProfileFields(tenantId: string, userId: string, fields: Partial<Pick<UserProfile, 'displayName' | 'preferredOutputFormat' | 'skillLevel' | 'communicationStyle' | 'timezone' | 'language'>>): Promise<void>;
    /**
     * renderProfile — render a UserProfile as an XML block for system-prompt injection.
     *
     * Returns an empty string for null (new user — no profile data yet).
     * The rendered block is bounded by userProfileTokenCap characters (character
     * count is used as a proxy for token count — the tokenizer is not available here).
     * If the full render exceeds the cap, the lowest-confidence preference is dropped
     * repeatedly until the string fits. Scalar fields are never truncated.
     */
    renderProfile(profile: UserProfile | null): string;
}
//# sourceMappingURL=UserProfileStore.d.ts.map