"use strict";
/**
 * ProjectRegistry — tier 3. Durable tenant-scoped project entity.
 *
 * A Project is the unit that gives the agent "always remember my project"
 * semantics. It holds:
 *   • Human-readable identity (name, description, tags).
 *   • Invariants — key/value facts the agent has learned ("db = Postgres",
 *     "auth lives in packages/auth/", "user prefers Tailwind"). These are
 *     authoritative; they override conflicting signals from lower tiers.
 *   • A bounded FIFO of the most recent session ids so cross-session
 *     continuity can load the last N conversations with a single lookup.
 *
 * Storage: Redis hash + per-tenant project-id set. Hashes make partial
 * updates cheap; a full project row is one HGETALL away. We also keep a
 * small secondary index by normalized name so `resolveByHint()` can answer
 * "continue my todo app" without a scan.
 *
 * Layout:
 *   oweibo:proj:{tenantId}:list             SET    (projectIds)
 *   oweibo:proj:{tenantId}:p:{projectId}    HASH   (name, description, invariants_json, recentSessions_json, tags_json, createdAt, updatedAt, archived)
 *   oweibo:proj:{tenantId}:byname:{slug}    STRING (projectId)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectRegistry = void 0;
const node_crypto_1 = require("node:crypto");
const MAX_RECENT_SESSIONS = 10;
class ProjectRegistry {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async create(tenantId, name, description) {
        const projectId = (0, node_crypto_1.randomUUID)();
        const now = new Date().toISOString();
        const project = {
            projectId,
            tenantId,
            name,
            description,
            createdAt: now,
            updatedAt: now,
            invariants: {},
            recentSessions: [],
            tags: [],
            archived: false,
        };
        await this.write(project);
        await this.redis.sadd(this.listKey(tenantId), projectId);
        await this.redis.set(this.nameKey(tenantId, name), projectId);
        return project;
    }
    async get(tenantId, projectId) {
        const raw = await this.redis.hgetall(this.projectKey(tenantId, projectId));
        if (!raw || Object.keys(raw).length === 0)
            return null;
        return this.hydrate(tenantId, projectId, raw);
    }
    async list(tenantId) {
        const ids = await this.redis.smembers(this.listKey(tenantId));
        const projects = await Promise.all(ids.map((id) => this.get(tenantId, id)));
        return projects
            .filter((p) => p !== null && !p.archived)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    async resolveByHint(tenantId, hint) {
        // 1. Exact-name hit via slug index.
        const direct = await this.redis.get(this.nameKey(tenantId, hint));
        if (direct) {
            const proj = await this.get(tenantId, direct);
            if (proj && !proj.archived)
                return proj;
        }
        // 2. Substring scan over tenant's project list. Cheap enough for realistic
        //    tenant sizes; upgrade to a fuzzy index if a tenant ever holds >1k projects.
        const all = await this.list(tenantId);
        const needle = hint.toLowerCase().trim();
        if (!needle)
            return null;
        const exact = all.find((p) => p.name.toLowerCase() === needle);
        if (exact)
            return exact;
        const tagHit = all.find((p) => p.tags.some((t) => t.toLowerCase() === needle));
        if (tagHit)
            return tagHit;
        const partial = all.find((p) => p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle));
        return partial ?? null;
    }
    async setInvariant(tenantId, projectId, key, value) {
        const existing = await this.get(tenantId, projectId);
        if (!existing)
            throw new Error(`project not found: ${tenantId}/${projectId}`);
        const updated = {
            ...existing,
            invariants: { ...existing.invariants, [key]: value },
            updatedAt: new Date().toISOString(),
        };
        await this.write(updated);
    }
    async touch(tenantId, projectId, sessionId) {
        const existing = await this.get(tenantId, projectId);
        if (!existing)
            return;
        // Move the session to the front of recentSessions, capped to MAX_RECENT_SESSIONS.
        const deduped = [sessionId, ...existing.recentSessions.filter((s) => s !== sessionId)]
            .slice(0, MAX_RECENT_SESSIONS);
        const updated = {
            ...existing,
            recentSessions: deduped,
            updatedAt: new Date().toISOString(),
        };
        await this.write(updated);
    }
    async archive(tenantId, projectId) {
        const existing = await this.get(tenantId, projectId);
        if (!existing)
            return;
        const updated = { ...existing, archived: true, updatedAt: new Date().toISOString() };
        await this.write(updated);
    }
    // ── Internals ─────────────────────────────────────────────────────────────
    async write(project) {
        const key = this.projectKey(project.tenantId, project.projectId);
        const fields = {
            name: project.name,
            description: project.description,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            archived: project.archived ? '1' : '0',
            invariants: JSON.stringify(project.invariants),
            recentSessions: JSON.stringify(project.recentSessions),
            tags: JSON.stringify(project.tags),
        };
        if (this.redis.hmset) {
            await this.redis.hmset(key, fields);
        }
        else {
            for (const [f, v] of Object.entries(fields))
                await this.redis.hset(key, f, v);
        }
    }
    hydrate(tenantId, projectId, raw) {
        const safeParse = (s, fallback) => {
            if (!s)
                return fallback;
            try {
                return JSON.parse(s);
            }
            catch {
                return fallback;
            }
        };
        return {
            projectId,
            tenantId,
            name: raw['name'] ?? '',
            description: raw['description'] ?? '',
            createdAt: raw['createdAt'] ?? new Date().toISOString(),
            updatedAt: raw['updatedAt'] ?? new Date().toISOString(),
            archived: raw['archived'] === '1',
            invariants: safeParse(raw['invariants'], {}),
            recentSessions: safeParse(raw['recentSessions'], []),
            tags: safeParse(raw['tags'], []),
        };
    }
    listKey(t) { return `oweibo:proj:${t}:list`; }
    projectKey(t, p) { return `oweibo:proj:${t}:p:${p}`; }
    nameKey(t, name) {
        const slug = (0, node_crypto_1.createHash)('sha1').update(name.toLowerCase().trim()).digest('hex').slice(0, 16);
        return `oweibo:proj:${t}:byname:${slug}`;
    }
}
exports.ProjectRegistry = ProjectRegistry;
//# sourceMappingURL=ProjectRegistry.js.map