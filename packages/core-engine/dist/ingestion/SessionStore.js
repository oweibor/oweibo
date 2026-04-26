"use strict";
/**
 * SessionStore — cross-task session continuity (v5, §16b).
 *
 * Stores the history of tasks completed within a user session so the agent
 * can reference prior decisions, avoid repeating clarifications, and maintain
 * a coherent narrative across a multi-task workflow.
 *
 * Storage: Redis hash `session:{sessionId}` with a 7-day TTL (rolling).
 * Each append resets the TTL so active sessions never expire mid-flight.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
class SessionStore {
    redisGet;
    redisSetEx;
    constructor(redisGet, redisSetEx) {
        this.redisGet = redisGet;
        this.redisSetEx = redisSetEx;
    }
    key(sessionId) {
        return `session:${sessionId}`;
    }
    async load(sessionId) {
        const raw = await this.redisGet(this.key(sessionId));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    async save(data) {
        await this.redisSetEx(this.key(data.sessionId), SESSION_TTL_SECONDS, JSON.stringify(data));
    }
    async appendTask(sessionId, userId, summary) {
        const existing = await this.load(sessionId);
        const session = existing ?? {
            sessionId,
            userId,
            tenantId: '',
            createdAt: new Date().toISOString(),
            tasks: [],
            clarifications: {},
        };
        const updated = {
            ...session,
            tasks: [...session.tasks, summary],
        };
        await this.save(updated);
    }
    async recordClarification(sessionId, question, answer) {
        const existing = await this.load(sessionId);
        if (!existing)
            return;
        await this.save({
            ...existing,
            clarifications: { ...existing.clarifications, [question]: answer },
        });
    }
}
exports.SessionStore = SessionStore;
//# sourceMappingURL=SessionStore.js.map