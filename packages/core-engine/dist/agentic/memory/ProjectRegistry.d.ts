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
import type { IProjectRegistry, Project, ProjectId, SessionId, TenantId } from '@oweibo/core-contracts';
export interface IRegistryRedis {
    hset(key: string, field: string, value: string): Promise<number>;
    hmset?(key: string, obj: Record<string, string>): Promise<unknown>;
    hgetall(key: string): Promise<Record<string, string>>;
    sadd(key: string, value: string): Promise<number>;
    srem(key: string, value: string): Promise<number>;
    smembers(key: string): Promise<string[]>;
    set(key: string, value: string): Promise<unknown>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
}
export declare class ProjectRegistry implements IProjectRegistry {
    private readonly redis;
    constructor(redis: IRegistryRedis);
    create(tenantId: TenantId, name: string, description: string): Promise<Project>;
    get(tenantId: TenantId, projectId: ProjectId): Promise<Project | null>;
    list(tenantId: TenantId): Promise<readonly Project[]>;
    resolveByHint(tenantId: TenantId, hint: string): Promise<Project | null>;
    setInvariant(tenantId: TenantId, projectId: ProjectId, key: string, value: string): Promise<void>;
    touch(tenantId: TenantId, projectId: ProjectId, sessionId: SessionId): Promise<void>;
    archive(tenantId: TenantId, projectId: ProjectId): Promise<void>;
    private write;
    private hydrate;
    private listKey;
    private projectKey;
    private nameKey;
}
//# sourceMappingURL=ProjectRegistry.d.ts.map