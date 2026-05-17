"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptRegistry = void 0;
exports.computeSlotHash = computeSlotHash;
// DONE: Phase A.3 — content-addressed, Postgres-backed prompt registry
const crypto_1 = require("crypto");
/** SHA256(role:slotId:templateVersion:text) — canonical content address. */
function computeSlotHash(role, slotId, templateVersion, text) {
    return (0, crypto_1.createHash)('sha256')
        .update(`${role}:${slotId}:${templateVersion}:${text}`)
        .digest('hex');
}
/**
 * PromptRegistry — Postgres-authoritative, Langfuse-mirrored prompt slot store.
 *
 * Invariants:
 *   - hash = SHA256(role:slotId:templateVersion:text) — computed before any write
 *   - 60s in-memory TTL cache; no stale reads past TTL
 *   - register() is idempotent: same hash → no-op INSERT ON CONFLICT
 *   - Langfuse mirror is best-effort; failure never throws into caller
 */
class PromptRegistry {
    pg;
    langfuseSecretKey;
    langfusePublicKey;
    cache = new Map();
    channelCache = new Map();
    static TTL_MS = 60_000;
    constructor(pg, langfuseSecretKey, langfusePublicKey) {
        this.pg = pg;
        this.langfuseSecretKey = langfuseSecretKey;
        this.langfusePublicKey = langfusePublicKey;
    }
    /** Look up a slot version by its content hash. */
    async get(hash) {
        const cached = this.fromCache(this.cache, hash);
        if (cached)
            return cached;
        const { rows } = await this.pg.query(`SELECT hash, role, slot_id AS "slotId", template_version AS "templateVersion",
              text, parent_hash AS "parentHash", mutation_status AS "mutationStatus",
              freeze_reason AS "freezeReason", eval_score AS "evalScore",
              created_at AS "createdAt", updated_by AS "updatedBy"
       FROM oweibo.prompt_versions WHERE hash = $1`, [hash]);
        if (rows.length === 0)
            throw new Error(`[PromptRegistry] unknown hash: ${hash}`);
        const row = rows[0];
        this.toCache(this.cache, hash, row);
        return row;
    }
    /**
     * Resolve the current channel pointer to its PromptVersionRecord.
     * Falls back to stable-v0 if channel row is missing.
     */
    async getChannelPointer(channel, role, slotId) {
        const cacheKey = `${channel}:${role}:${slotId}`;
        const cached = this.fromCache(this.channelCache, cacheKey);
        if (cached)
            return cached;
        const { rows } = await this.pg.query(`SELECT prompt_hash AS "promptHash"
       FROM oweibo.channels
       WHERE name = $1 AND role = $2 AND slot_id = $3`, [channel, role, slotId]);
        let hash;
        if (rows.length === 0) {
            // DECISION: fall back to stable-v0 if channel pointer missing (invariant §2.8)
            const fallback = await this.pg.query(`SELECT prompt_hash AS "promptHash"
         FROM oweibo.channels
         WHERE name = 'stable-v0' AND role = $1 AND slot_id = $2`, [role, slotId]);
            if (fallback.rows.length === 0)
                throw new Error(`[PromptRegistry] no channel pointer for ${channel}/${role}/${slotId} and no stable-v0 fallback`);
            hash = fallback.rows[0].promptHash;
        }
        else {
            hash = rows[0].promptHash;
        }
        const record = await this.get(hash);
        this.toCache(this.channelCache, cacheKey, record);
        return record;
    }
    /**
     * Register a new slot version.  Idempotent — same content → same hash, no double-write.
     * Mirrors to Langfuse asynchronously after Postgres write succeeds.
     */
    async register(input) {
        const hash = computeSlotHash(input.role, input.slotId, input.templateVersion, input.text);
        await this.pg.query(`INSERT INTO oweibo.prompt_versions
         (hash, role, slot_id, template_version, text, parent_hash, mutation_status, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'stable', $7)
       ON CONFLICT (hash) DO NOTHING`, [hash, input.role, input.slotId, input.templateVersion, input.text,
            input.parentHash ?? null, input.updatedBy ?? null]);
        const record = await this.get(hash);
        this.mirrorToLangfuse(input, hash, record.text).catch(() => {
            // non-fatal — Langfuse is a read mirror, not the source of truth
        });
        return record;
    }
    /** Get all slot IDs for a given role + channel. */
    async listSlots(channel, role) {
        const { rows } = await this.pg.query(`SELECT name, role, slot_id AS "slotId", prompt_hash AS "promptHash",
              version, updated_at AS "updatedAt", updated_by AS "updatedBy"
       FROM oweibo.channels
       WHERE name = $1 AND role = $2`, [channel, role]);
        return rows;
    }
    /** Flip a channel pointer to a new hash (optimistic lock via version column). */
    async updateChannelPointer(channel, role, slotId, newHash, expectedVersion, updatedBy) {
        const result = await this.pg.query(`UPDATE oweibo.channels
       SET prompt_hash = $4, version = version + 1, updated_at = NOW(), updated_by = $5
       WHERE name = $1 AND role = $2 AND slot_id = $3 AND version = $6`, [channel, role, slotId, newHash, updatedBy, expectedVersion]);
        if (result.rowCount === 0)
            throw new Error(`[PromptRegistry] optimistic lock conflict updating ${channel}/${role}/${slotId}`);
        // Invalidate channel cache so next resolve fetches fresh
        this.channelCache.delete(`${channel}:${role}:${slotId}`);
    }
    fromCache(map, key) {
        const entry = map.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            map.delete(key);
            return undefined;
        }
        return entry.value;
    }
    toCache(map, key, value) {
        map.set(key, { value, expiresAt: Date.now() + PromptRegistry.TTL_MS });
    }
    async mirrorToLangfuse(input, hash, text) {
        if (!this.langfuseSecretKey || !this.langfusePublicKey)
            return;
        try {
            const { Langfuse } = await import('langfuse');
            const lf = new Langfuse({ secretKey: this.langfuseSecretKey, publicKey: this.langfusePublicKey });
            await lf.createPrompt({
                name: `${input.role}:${input.slotId}:${input.templateVersion}`,
                prompt: text,
                labels: ['slot', input.role, input.slotId, hash.slice(0, 8)],
                type: 'text',
            });
        }
        catch {
            // non-fatal
        }
    }
}
exports.PromptRegistry = PromptRegistry;
//# sourceMappingURL=PromptRegistry.js.map