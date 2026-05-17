"use strict";
/**
 * DocGeneratorQueue — Redis-backed job queue for doc-gen runs (C1, v10.5).
 *
 * Uses RPUSH/BLPOP (consistent with existing TaskQueue pattern) instead of BullMQ
 * so that no additional dependency is required. Queue name: `doc-generator`.
 *
 * Idempotency (C3): stores idempotencyKey → sessionId in Redis with 24 h TTL.
 * Daily quota (C14): INCR doc-tokens:{tenantId}:{YYYY-MM-DD} against a per-tenant cap.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocGeneratorQueue = void 0;
const node_crypto_1 = require("node:crypto");
const QUEUE_KEY = 'doc-generator:queue';
const IDEMPOTENCY_NS = 'doc-idempotency';
const SESSION_NS = 'doc-session';
const HEARTBEAT_NS = 'doc-heartbeat';
const SESSION_TTL = 24 * 60 * 60; // 24 h
const HEARTBEAT_TTL = 30; // 30 s
const DAILY_QUOTA = 500_000; // tokens/day default
class DocGeneratorQueue {
    redis;
    config;
    constructor(redis, config = {}) {
        this.redis = redis;
        this.config = config;
    }
    async enqueue(job) {
        const { tenantId, idempotencyKey } = job;
        // ── Idempotency check ─────────────────────────────────────────────────────
        // On hit, return the current session state so the client can resume without
        // re-running analysis (completed/failed sessions included — LOW-4).
        if (idempotencyKey) {
            const iKey = `${IDEMPOTENCY_NS}:${tenantId}:${idempotencyKey}`;
            const existingSessionId = await this.redis.get(iKey);
            if (existingSessionId) {
                const state = await this.getStatus(tenantId, existingSessionId);
                return { sessionId: existingSessionId, queued: false, existing: true, sessionState: state ?? undefined };
            }
        }
        const sessionId = job.sessionId ?? (0, node_crypto_1.randomUUID)();
        // ── Session SETNX (C11) ───────────────────────────────────────────────────
        const sKey = `${SESSION_NS}:${tenantId}:${sessionId}`;
        const ok = await this.redis.setnx(sKey, JSON.stringify({ status: 'queued', enqueuedAt: new Date().toISOString() }));
        if (!ok) {
            return { sessionId, queued: false, existing: true };
        }
        await this.redis.expire(sKey, SESSION_TTL);
        // ── Store idempotency mapping ─────────────────────────────────────────────
        if (idempotencyKey) {
            const iKey = `${IDEMPOTENCY_NS}:${tenantId}:${idempotencyKey}`;
            await this.redis.setex(iKey, SESSION_TTL, sessionId);
        }
        // ── Enqueue job ───────────────────────────────────────────────────────────
        const payload = { ...job, sessionId };
        await this.redis.rpush(QUEUE_KEY, JSON.stringify(payload));
        return { sessionId, queued: true, existing: false };
    }
    async dequeue(timeoutSec = 30) {
        const res = await this.redis.blpop([QUEUE_KEY], timeoutSec);
        if (!res)
            return null;
        return JSON.parse(res[1]);
    }
    async cancel(tenantId, sessionId) {
        const sKey = `${SESSION_NS}:${tenantId}:${sessionId}`;
        const raw = await this.redis.get(sKey);
        if (!raw)
            return;
        const state = JSON.parse(raw);
        await this.redis.setex(sKey, SESSION_TTL, JSON.stringify({ ...state, status: 'cancelled', cancelledAt: new Date().toISOString() }));
    }
    async updateStatus(tenantId, sessionId, update) {
        const sKey = `${SESSION_NS}:${tenantId}:${sessionId}`;
        const raw = await this.redis.get(sKey);
        const prev = raw ? JSON.parse(raw) : {};
        await this.redis.setex(sKey, SESSION_TTL, JSON.stringify({ ...prev, ...update }));
    }
    async getStatus(tenantId, sessionId) {
        const raw = await this.redis.get(`${SESSION_NS}:${tenantId}:${sessionId}`);
        return raw ? JSON.parse(raw) : null;
    }
    async heartbeat(sessionId) {
        await this.redis.setex(`${HEARTBEAT_NS}:${sessionId}`, HEARTBEAT_TTL, 'alive');
    }
    async isAlive(sessionId) {
        const v = await this.redis.get(`${HEARTBEAT_NS}:${sessionId}`);
        return v === 'alive';
    }
    async checkDailyQuota(tenantId) {
        const today = new Date().toISOString().slice(0, 10);
        const key = `doc-tokens:${tenantId}:${today}`;
        const spent = Number(await this.redis.get(key) ?? 0);
        const limit = this.config.dailyTokenQuota ?? DAILY_QUOTA;
        return { ok: spent < limit, spent, limit };
    }
    async addTokenSpend(tenantId, tokens) {
        if (tokens <= 0)
            return;
        const today = new Date().toISOString().slice(0, 10);
        const key = `doc-tokens:${tenantId}:${today}`;
        await this.redis.incrby(key, tokens);
        // 48-hour TTL spans midnight boundaries safely
        await this.redis.expire(key, 48 * 3600);
    }
    /**
     * Returns the 0-based position of sessionId in the queue, or null if not queued.
     * Position 0 = next job to be dequeued (front of list). (MED-3)
     */
    async getPosition(sessionId) {
        const len = await this.redis.llen(QUEUE_KEY);
        if (len === 0)
            return null;
        const jobs = await this.redis.lrange(QUEUE_KEY, 0, len - 1);
        for (let i = 0; i < jobs.length; i++) {
            try {
                const job = JSON.parse(jobs[i]);
                if (job.sessionId === sessionId)
                    return i;
            }
            catch { /* skip malformed entry */ }
        }
        return null;
    }
}
exports.DocGeneratorQueue = DocGeneratorQueue;
//# sourceMappingURL=DocGeneratorQueue.js.map