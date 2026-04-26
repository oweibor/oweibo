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
import type { AppendResult, ConversationTurn, IShortTermMemoryStore, MemoryScope, ProjectId, SessionContext, SessionId, TenantId } from '@oweibo/core-contracts';
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
export declare class ShortTermMemoryStore implements IShortTermMemoryStore {
    private readonly redis;
    private readonly opts;
    constructor(redis: IRedisLike, opts?: ShortTermMemoryOptions);
    append(scope: MemoryScope, turn: ConversationTurn): Promise<AppendResult>;
    load(tenantId: TenantId, sessionId: SessionId): Promise<SessionContext | null>;
    setRollingSummary(tenantId: TenantId, sessionId: SessionId, summary: string, totalTurns: number): Promise<void>;
    bindProject(tenantId: TenantId, sessionId: SessionId, projectId: ProjectId): Promise<void>;
    listSessionsForProject(tenantId: TenantId, projectId: ProjectId, limit?: number): Promise<readonly SessionContext[]>;
    private turnsKey;
    private metaKey;
    private projectIndexKey;
    private indexProjectSession;
}
//# sourceMappingURL=ShortTermMemoryStore.d.ts.map