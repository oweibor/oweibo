/**
 * DocGeneratorQueue — Redis-backed job queue for doc-gen runs (C1, v10.5).
 *
 * Uses RPUSH/BLPOP (consistent with existing TaskQueue pattern) instead of BullMQ
 * so that no additional dependency is required. Queue name: `doc-generator`.
 *
 * Idempotency (C3): stores idempotencyKey → sessionId in Redis with 24 h TTL.
 * Daily quota (C14): INCR doc-tokens:{tenantId}:{YYYY-MM-DD} against a per-tenant cap.
 */

import { randomUUID } from 'node:crypto';
import type { DocGenJob } from '../DocGeneratorPipeline.js';

const QUEUE_KEY      = 'doc-generator:queue';
const IDEMPOTENCY_NS = 'doc-idempotency';
const SESSION_NS     = 'doc-session';
const HEARTBEAT_NS   = 'doc-heartbeat';
const SESSION_TTL    = 24 * 60 * 60;          // 24 h
const HEARTBEAT_TTL  = 30;                     // 30 s
const DAILY_QUOTA    = 500_000;                // tokens/day default

type RedisClient = {
  rpush(key: string, ...values: string[]): Promise<number>;
  blpop(keys: string[], timeout: number): Promise<[string, string] | null>;
  llen(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  setnx(key: string, value: string): Promise<number>;
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
  del(key: string): Promise<number>;
};

export interface EnqueueResult {
  readonly sessionId:    string;
  readonly queued:       boolean;        // false when idempotency hit returned existing session
  readonly existing:     boolean;
  /** Present when existing=true — the current session state for the client to inspect (LOW-4). */
  readonly sessionState?: Record<string, unknown>;
}

export class DocGeneratorQueue {
  constructor(
    private readonly redis:  RedisClient,
    private readonly config: { dailyTokenQuota?: number } = {},
  ) {}

  async enqueue(job: Omit<DocGenJob, 'sessionId'> & { sessionId?: string }): Promise<EnqueueResult> {
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

    const sessionId = job.sessionId ?? randomUUID();

    // ── Session SETNX (C11) ───────────────────────────────────────────────────
    const sKey = `${SESSION_NS}:${tenantId}:${sessionId}`;
    const ok   = await this.redis.setnx(sKey, JSON.stringify({ status: 'queued', enqueuedAt: new Date().toISOString() }));
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
    const payload: DocGenJob = { ...job, sessionId };
    await this.redis.rpush(QUEUE_KEY, JSON.stringify(payload));

    return { sessionId, queued: true, existing: false };
  }

  async dequeue(timeoutSec = 30): Promise<DocGenJob | null> {
    const res = await this.redis.blpop([QUEUE_KEY], timeoutSec);
    if (!res) return null;
    return JSON.parse(res[1]) as DocGenJob;
  }

  async cancel(tenantId: string, sessionId: string): Promise<void> {
    const sKey = `${SESSION_NS}:${tenantId}:${sessionId}`;
    const raw  = await this.redis.get(sKey);
    if (!raw) return;
    const state = JSON.parse(raw) as Record<string, unknown>;
    await this.redis.setex(sKey, SESSION_TTL, JSON.stringify({ ...state, status: 'cancelled', cancelledAt: new Date().toISOString() }));
  }

  async updateStatus(
    tenantId:  string,
    sessionId: string,
    update:    Record<string, unknown>,
  ): Promise<void> {
    const sKey = `${SESSION_NS}:${tenantId}:${sessionId}`;
    const raw  = await this.redis.get(sKey);
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    await this.redis.setex(sKey, SESSION_TTL, JSON.stringify({ ...prev, ...update }));
  }

  async getStatus(tenantId: string, sessionId: string): Promise<Record<string, unknown> | null> {
    const raw = await this.redis.get(`${SESSION_NS}:${tenantId}:${sessionId}`);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  async heartbeat(sessionId: string): Promise<void> {
    await this.redis.setex(`${HEARTBEAT_NS}:${sessionId}`, HEARTBEAT_TTL, 'alive');
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const v = await this.redis.get(`${HEARTBEAT_NS}:${sessionId}`);
    return v === 'alive';
  }

  async checkDailyQuota(tenantId: string): Promise<{ ok: boolean; spent: number; limit: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const key   = `doc-tokens:${tenantId}:${today}`;
    const spent = Number(await this.redis.get(key) ?? 0);
    const limit = this.config.dailyTokenQuota ?? DAILY_QUOTA;
    return { ok: spent < limit, spent, limit };
  }

  async addTokenSpend(tenantId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const key   = `doc-tokens:${tenantId}:${today}`;
    await this.redis.incrby(key, tokens);
    // 48-hour TTL spans midnight boundaries safely
    await this.redis.expire(key, 48 * 3600);
  }

  /**
   * Returns the 0-based position of sessionId in the queue, or null if not queued.
   * Position 0 = next job to be dequeued (front of list). (MED-3)
   */
  async getPosition(sessionId: string): Promise<number | null> {
    const len  = await this.redis.llen(QUEUE_KEY);
    if (len === 0) return null;
    const jobs = await this.redis.lrange(QUEUE_KEY, 0, len - 1);
    for (let i = 0; i < jobs.length; i++) {
      try {
        const job = JSON.parse(jobs[i]!) as { sessionId?: string };
        if (job.sessionId === sessionId) return i;
      } catch { /* skip malformed entry */ }
    }
    return null;
  }
}
