"use strict";
/**
 * ShortTermMemoryStore — tier 2. Redis-backed per-session conversation buffer.
 *
 * Layout (all keys are tenant-prefixed; never cross-tenant):
 *
 *   oweibo:stm:{tenantId}:sess:{sessionId}:turns   LIST  (recent turns, JSON)
 *   oweibo:stm:{tenantId}:sess:{sessionId}:meta    HASH  (rollingSummary, totalTurns, projectId, lastActiveAt)
 *   oweibo:stm:{tenantId}:proj:{projectId}:sessions ZSET (sessionId by lastActiveAt)
 *
 * TTLs:
 *   • Turns list: sliding TTL (default 7d), refreshed on append.
 *   • Meta hash:  same TTL.
 *   • Project→sessions ZSET: 90d (long enough to carry cross-session continuity,
 *     short enough to stay bounded).
 *
 * Recent-turn buffer is capped at MAX_RECENT_TURNS; older turns are folded
 * into the rolling summary by MemoryOrchestrator at append time.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShortTermMemoryStore = void 0;
const DEFAULTS = {
    sessionTtlSeconds: 60 * 60 * 24 * 7,
    maxRecentTurns: 24,
    projectIndexTtlSeconds: 60 * 60 * 24 * 90,
};
class ShortTermMemoryStore {
    redis;
    opts;
    constructor(redis, opts = {}) {
        this.redis = redis;
        this.opts = { ...DEFAULTS, ...opts };
    }
    // ── Public API ───────────────────────────────────────────────────────────
    async append(scope, turn) {
        if (!scope.sessionId) {
            throw new Error('ShortTermMemoryStore.append: scope.sessionId is required');
        }
        const { tenantId, sessionId } = scope;
        const turnsKey = this.turnsKey(tenantId, sessionId);
        const metaKey = this.metaKey(tenantId, sessionId);
        await this.redis.rpush(turnsKey, JSON.stringify(turn));
        const len = await this.redis.llen(turnsKey);
        // Window-trim: load the about-to-be-dropped slice before ltrim so the
        // caller can fold it into the rolling summary. Without this, evicted
        // turns are gone forever and the rolling summary drifts out of sync.
        let droppedTurns = [];
        if (len > this.opts.maxRecentTurns) {
            const dropCount = len - this.opts.maxRecentTurns;
            const rawDropped = await this.redis.lrange(turnsKey, 0, dropCount - 1);
            droppedTurns = rawDropped
                .map((raw) => { try {
                return JSON.parse(raw);
            }
            catch {
                return null;
            } })
                .filter((t) => t !== null);
            await this.redis.ltrim(turnsKey, dropCount, -1);
        }
        await this.redis.hset(metaKey, 'lastActiveAt', turn.at);
        await this.redis.hset(metaKey, 'totalTurns', String(len));
        if (scope.projectId) {
            await this.redis.hset(metaKey, 'projectId', scope.projectId);
            await this.indexProjectSession(tenantId, scope.projectId, sessionId, Date.parse(turn.at));
        }
        await this.redis.expire(turnsKey, this.opts.sessionTtlSeconds);
        await this.redis.expire(metaKey, this.opts.sessionTtlSeconds);
        return { droppedTurns, totalTurns: len };
    }
    async load(tenantId, sessionId) {
        const turnsKey = this.turnsKey(tenantId, sessionId);
        const metaKey = this.metaKey(tenantId, sessionId);
        const [rawTurns, meta] = await Promise.all([
            this.redis.lrange(turnsKey, 0, -1),
            this.redis.hgetall(metaKey),
        ]);
        if (rawTurns.length === 0 && Object.keys(meta).length === 0)
            return null;
        const recentTurns = rawTurns
            .map((raw) => { try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        } })
            .filter((t) => t !== null);
        return {
            sessionId,
            tenantId,
            projectId: meta['projectId'],
            recentTurns,
            rollingSummary: meta['rollingSummary'] ?? '',
            totalTurns: Number(meta['totalTurns'] ?? recentTurns.length),
            lastActiveAt: meta['lastActiveAt'] ?? new Date().toISOString(),
        };
    }
    async setRollingSummary(tenantId, sessionId, summary, totalTurns) {
        const metaKey = this.metaKey(tenantId, sessionId);
        await this.redis.hset(metaKey, 'rollingSummary', summary);
        await this.redis.hset(metaKey, 'totalTurns', String(totalTurns));
        await this.redis.expire(metaKey, this.opts.sessionTtlSeconds);
    }
    async bindProject(tenantId, sessionId, projectId) {
        const metaKey = this.metaKey(tenantId, sessionId);
        await this.redis.hset(metaKey, 'projectId', projectId);
        await this.redis.expire(metaKey, this.opts.sessionTtlSeconds);
        await this.indexProjectSession(tenantId, projectId, sessionId, Date.now());
    }
    async listSessionsForProject(tenantId, projectId, limit = 10) {
        const indexKey = this.projectIndexKey(tenantId, projectId);
        const ids = await this.redis.zrevrange(indexKey, 0, limit - 1);
        const contexts = await Promise.all(ids.map((id) => this.load(tenantId, id)));
        return contexts.filter((c) => c !== null);
    }
    // ── Keying ───────────────────────────────────────────────────────────────
    turnsKey(t, s) { return `oweibo:stm:${t}:sess:${s}:turns`; }
    metaKey(t, s) { return `oweibo:stm:${t}:sess:${s}:meta`; }
    projectIndexKey(t, p) {
        return `oweibo:stm:${t}:proj:${p}:sessions`;
    }
    async indexProjectSession(t, p, s, score) {
        const key = this.projectIndexKey(t, p);
        await this.redis.zadd(key, score, s);
        await this.redis.expire(key, this.opts.projectIndexTtlSeconds);
    }
}
exports.ShortTermMemoryStore = ShortTermMemoryStore;
//# sourceMappingURL=ShortTermMemoryStore.js.map