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

import { createHash, randomUUID } from 'node:crypto';

import type {
  IProjectRegistry,
  Project,
  ProjectId,
  SessionId,
  TenantId,
} from '@oweibo/core-contracts';

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

const MAX_RECENT_SESSIONS = 10;

export class ProjectRegistry implements IProjectRegistry {
  constructor(private readonly redis: IRegistryRedis) {}

  async create(tenantId: TenantId, name: string, description: string): Promise<Project> {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const project: Project = {
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

  async get(tenantId: TenantId, projectId: ProjectId): Promise<Project | null> {
    const raw = await this.redis.hgetall(this.projectKey(tenantId, projectId));
    if (!raw || Object.keys(raw).length === 0) return null;
    return this.hydrate(tenantId, projectId, raw);
  }

  async list(tenantId: TenantId): Promise<readonly Project[]> {
    const ids = await this.redis.smembers(this.listKey(tenantId));
    const projects = await Promise.all(ids.map((id) => this.get(tenantId, id)));
    return projects
      .filter((p): p is Project => p !== null && !p.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async resolveByHint(tenantId: TenantId, hint: string): Promise<Project | null> {
    // 1. Exact-name hit via slug index.
    const direct = await this.redis.get(this.nameKey(tenantId, hint));
    if (direct) {
      const proj = await this.get(tenantId, direct);
      if (proj && !proj.archived) return proj;
    }
    // 2. Substring scan over tenant's project list. Cheap enough for realistic
    //    tenant sizes; upgrade to a fuzzy index if a tenant ever holds >1k projects.
    const all = await this.list(tenantId);
    const needle = hint.toLowerCase().trim();
    if (!needle) return null;
    const exact = all.find((p) => p.name.toLowerCase() === needle);
    if (exact) return exact;
    const tagHit = all.find((p) => p.tags.some((t) => t.toLowerCase() === needle));
    if (tagHit) return tagHit;
    const partial = all.find((p) =>
      p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle),
    );
    return partial ?? null;
  }

  async setInvariant(
    tenantId: TenantId, projectId: ProjectId, key: string, value: string,
  ): Promise<void> {
    const existing = await this.get(tenantId, projectId);
    if (!existing) throw new Error(`project not found: ${tenantId}/${projectId}`);
    const updated: Project = {
      ...existing,
      invariants: { ...existing.invariants, [key]: value },
      updatedAt: new Date().toISOString(),
    };
    await this.write(updated);
  }

  async touch(tenantId: TenantId, projectId: ProjectId, sessionId: SessionId): Promise<void> {
    const existing = await this.get(tenantId, projectId);
    if (!existing) return;
    // Move the session to the front of recentSessions, capped to MAX_RECENT_SESSIONS.
    const deduped = [sessionId, ...existing.recentSessions.filter((s) => s !== sessionId)]
      .slice(0, MAX_RECENT_SESSIONS);
    const updated: Project = {
      ...existing,
      recentSessions: deduped,
      updatedAt: new Date().toISOString(),
    };
    await this.write(updated);
  }

  async archive(tenantId: TenantId, projectId: ProjectId): Promise<void> {
    const existing = await this.get(tenantId, projectId);
    if (!existing) return;
    const updated: Project = { ...existing, archived: true, updatedAt: new Date().toISOString() };
    await this.write(updated);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async write(project: Project): Promise<void> {
    const key = this.projectKey(project.tenantId, project.projectId);
    const fields: Record<string, string> = {
      name:            project.name,
      description:     project.description,
      createdAt:       project.createdAt,
      updatedAt:       project.updatedAt,
      archived:        project.archived ? '1' : '0',
      invariants:      JSON.stringify(project.invariants),
      recentSessions:  JSON.stringify(project.recentSessions),
      tags:            JSON.stringify(project.tags),
    };
    if (this.redis.hmset) {
      await this.redis.hmset(key, fields);
    } else {
      for (const [f, v] of Object.entries(fields)) await this.redis.hset(key, f, v);
    }
  }

  private hydrate(tenantId: TenantId, projectId: ProjectId, raw: Record<string, string>): Project {
    const safeParse = <T>(s: string | undefined, fallback: T): T => {
      if (!s) return fallback;
      try { return JSON.parse(s) as T; } catch { return fallback; }
    };
    return {
      projectId,
      tenantId,
      name:           raw['name'] ?? '',
      description:    raw['description'] ?? '',
      createdAt:      raw['createdAt'] ?? new Date().toISOString(),
      updatedAt:      raw['updatedAt'] ?? new Date().toISOString(),
      archived:       raw['archived'] === '1',
      invariants:     safeParse<Record<string, string>>(raw['invariants'], {}),
      recentSessions: safeParse<SessionId[]>(raw['recentSessions'], []),
      tags:           safeParse<string[]>(raw['tags'], []),
    };
  }

  private listKey(t: TenantId): string { return `oweibo:proj:${t}:list`; }
  private projectKey(t: TenantId, p: ProjectId): string { return `oweibo:proj:${t}:p:${p}`; }
  private nameKey(t: TenantId, name: string): string {
    const slug = createHash('sha1').update(name.toLowerCase().trim()).digest('hex').slice(0, 16);
    return `oweibo:proj:${t}:byname:${slug}`;
  }
}
