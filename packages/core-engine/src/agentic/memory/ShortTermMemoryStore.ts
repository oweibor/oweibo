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

import type {
  AppendResult,
  ConversationTurn,
  IShortTermMemoryStore,
  MemoryScope,
  ProjectId,
  SessionContext,
  SessionId,
  TenantId,
} from '@oweibo/core-contracts';

/** Minimal subset of ioredis/Redis we actually use; keeps the module test-friendly. */
export interface IRedisLike {
  rpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  llen(key: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<number>;
}

export interface ShortTermMemoryOptions {
  /** Sliding TTL for session keys, in seconds. Default: 7 days. */
  readonly sessionTtlSeconds?: number;
  /** How many turns to keep verbatim before folding into rollingSummary. */
  readonly maxRecentTurns?: number;
  /** TTL for the project → sessions ZSET. Default: 90 days. */
  readonly projectIndexTtlSeconds?: number;
}

const DEFAULTS: Required<ShortTermMemoryOptions> = {
  sessionTtlSeconds:       60 * 60 * 24 * 7,
  maxRecentTurns:          24,
  projectIndexTtlSeconds:  60 * 60 * 24 * 90,
};

export class ShortTermMemoryStore implements IShortTermMemoryStore {
  private readonly opts: Required<ShortTermMemoryOptions>;

  constructor(
    private readonly redis: IRedisLike,
    opts: ShortTermMemoryOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async append(scope: MemoryScope, turn: ConversationTurn): Promise<AppendResult> {
    if (!scope.sessionId) {
      throw new Error('ShortTermMemoryStore.append: scope.sessionId is required');
    }
    const { tenantId, sessionId } = scope;
    const turnsKey = this.turnsKey(tenantId, sessionId);
    const metaKey  = this.metaKey(tenantId, sessionId);

    await this.redis.rpush(turnsKey, JSON.stringify(turn));
    const len = await this.redis.llen(turnsKey);

    // Window-trim: load the about-to-be-dropped slice before ltrim so the
    // caller can fold it into the rolling summary. Without this, evicted
    // turns are gone forever and the rolling summary drifts out of sync.
    let droppedTurns: readonly ConversationTurn[] = [];
    if (len > this.opts.maxRecentTurns) {
      const dropCount = len - this.opts.maxRecentTurns;
      const rawDropped = await this.redis.lrange(turnsKey, 0, dropCount - 1);
      droppedTurns = rawDropped
        .map((raw) => { try { return JSON.parse(raw) as ConversationTurn; } catch { return null; } })
        .filter((t): t is ConversationTurn => t !== null);
      await this.redis.ltrim(turnsKey, dropCount, -1);
    }

    await this.redis.hset(metaKey, 'lastActiveAt', turn.at);
    await this.redis.hset(metaKey, 'totalTurns',   String(len));
    if (scope.projectId) {
      await this.redis.hset(metaKey, 'projectId', scope.projectId);
      await this.indexProjectSession(tenantId, scope.projectId, sessionId, Date.parse(turn.at));
    }

    await this.redis.expire(turnsKey, this.opts.sessionTtlSeconds);
    await this.redis.expire(metaKey,  this.opts.sessionTtlSeconds);

    return { droppedTurns, totalTurns: len };
  }

  async load(tenantId: TenantId, sessionId: SessionId): Promise<SessionContext | null> {
    const turnsKey = this.turnsKey(tenantId, sessionId);
    const metaKey  = this.metaKey(tenantId, sessionId);

    const [rawTurns, meta] = await Promise.all([
      this.redis.lrange(turnsKey, 0, -1),
      this.redis.hgetall(metaKey),
    ]);
    if (rawTurns.length === 0 && Object.keys(meta).length === 0) return null;

    const recentTurns = rawTurns
      .map((raw) => { try { return JSON.parse(raw) as ConversationTurn; } catch { return null; } })
      .filter((t): t is ConversationTurn => t !== null);

    return {
      sessionId,
      tenantId,
      projectId:      meta['projectId'],
      recentTurns,
      rollingSummary: meta['rollingSummary'] ?? '',
      totalTurns:     Number(meta['totalTurns'] ?? recentTurns.length),
      lastActiveAt:   meta['lastActiveAt'] ?? new Date().toISOString(),
    };
  }

  async setRollingSummary(
    tenantId: TenantId, sessionId: SessionId, summary: string, totalTurns: number,
  ): Promise<void> {
    const metaKey = this.metaKey(tenantId, sessionId);
    await this.redis.hset(metaKey, 'rollingSummary', summary);
    await this.redis.hset(metaKey, 'totalTurns', String(totalTurns));
    await this.redis.expire(metaKey, this.opts.sessionTtlSeconds);
  }

  async bindProject(tenantId: TenantId, sessionId: SessionId, projectId: ProjectId): Promise<void> {
    const metaKey = this.metaKey(tenantId, sessionId);
    await this.redis.hset(metaKey, 'projectId', projectId);
    await this.redis.expire(metaKey, this.opts.sessionTtlSeconds);
    await this.indexProjectSession(tenantId, projectId, sessionId, Date.now());
  }

  async listSessionsForProject(
    tenantId: TenantId, projectId: ProjectId, limit = 10,
  ): Promise<readonly SessionContext[]> {
    const indexKey = this.projectIndexKey(tenantId, projectId);
    const ids = await this.redis.zrevrange(indexKey, 0, limit - 1);
    const contexts = await Promise.all(ids.map((id) => this.load(tenantId, id)));
    return contexts.filter((c): c is SessionContext => c !== null);
  }

  // ── Keying ───────────────────────────────────────────────────────────────

  private turnsKey(t: TenantId, s: SessionId): string { return `oweibo:stm:${t}:sess:${s}:turns`; }
  private metaKey (t: TenantId, s: SessionId): string { return `oweibo:stm:${t}:sess:${s}:meta`; }
  private projectIndexKey(t: TenantId, p: ProjectId): string {
    return `oweibo:stm:${t}:proj:${p}:sessions`;
  }

  private async indexProjectSession(
    t: TenantId, p: ProjectId, s: SessionId, score: number,
  ): Promise<void> {
    const key = this.projectIndexKey(t, p);
    await this.redis.zadd(key, score, s);
    await this.redis.expire(key, this.opts.projectIndexTtlSeconds);
  }
}
