/**
 * ShortTermMemoryStore — two-layer session memory.
 *
 * HOT layer — in-process Map<sessionId, STMEntry[]>.
 *   Zero external I/O. Bounded to stmHotWindowSize entries per session.
 *   Oldest entries are evicted (shift) when the window is exceeded; they remain
 *   in the warm layer. Lost on worker restart — degradation is graceful.
 *
 * WARM layer — Redis Stack HNSW VSS per tenant.
 *   One FT.CREATE index per tenant (stm-idx:{tenantId}), session isolation via
 *   @sessionId TAG filter on FT.SEARCH. Entry keys: stm:{tenantId}:{sessionId}:{id}.
 *   Session counter key: stm-count:{tenantId}:{sessionId}.
 *   Both expire at stmTtlSeconds (default 1h).
 *   Entry-count cap enforced by atomic INCR before write; excess throws StorageCapExceededError.
 *   Requires Redis Stack (redis-stack-server or Redis Cloud with Search module).
 *   Returns empty array on any Redis or parse error — never throws from recall().
 */

import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { EmbeddingCache } from './EmbeddingCache.js';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class StorageCapExceededError extends Error {
  constructor(
    public readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageCapExceededError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface STMEntry {
  id:            string;
  tenantId:      string;
  userId?:       string;
  sessionId:     string;
  scope:         string;
  summary:       string;
  detail:        unknown;
  relevanceTags: string[];
  turnIndex:     number;
  createdAt:     number;
  embedding?:    number[];
}

export interface STMHotConfig {
  stmHotWindowSize:        number;  // default: 20
  maxStmEntriesPerSession: number;  // default: 500
  stmTtlSeconds:           number;  // default: 3600
}

export const DEFAULT_STM_HOT_CONFIG: STMHotConfig = {
  stmHotWindowSize:        20,
  maxStmEntriesPerSession: 500,
  stmTtlSeconds:           3_600,
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Safe JSON parse — returns the raw string on failure rather than throwing. */
function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Escape characters that are special inside a Redis Tag field value.
 * Required for UUIDs (contain hyphens) used as sessionId TAG filters.
 */
function escapeTag(s: string): string {
  return s.replace(/([,.<>{}[\]"':;!@#$%^&*()\-+=~| ])/g, '\\$1');
}

/**
 * Reconstruct an STMEntry from a flat Redis hash map (all values are strings).
 * Returns null if any required field is absent.
 */
function hashToEntry(map: Record<string, string>): STMEntry | null {
  const id          = map['id'];
  const tenantId    = map['tenantId'];
  const sessionId   = map['sessionId'];
  const scope       = map['scope'];
  const summary     = map['summary'];
  const turnIdxStr  = map['turnIndex'];
  const createdStr  = map['createdAt'];

  if (!id || !tenantId || !sessionId || !scope || !summary ||
      !turnIdxStr || !createdStr) return null;

  return {
    id,
    tenantId,
    sessionId,
    scope,
    summary,
    detail:        tryParseJson(map['detail'] ?? '{}'),
    relevanceTags: tryParseJson(map['tags']   ?? '[]') as string[],
    turnIndex:     parseInt(turnIdxStr, 10),
    createdAt:     parseInt(createdStr, 10),
    userId:        map['userId'] || undefined,
  };
}

/**
 * Parse the raw FT.SEARCH response into STMEntry[].
 * Response layout: [totalCount, key1, fieldsArray1, key2, fieldsArray2, …]
 * where each fieldsArray is [field, value, field, value, …].
 */
function parseSearchResults(raw: unknown[]): STMEntry[] {
  const entries: STMEntry[] = [];
  // index 0 is total count; entries start at index 1 in steps of 2
  for (let i = 1; i + 1 < raw.length; i += 2) {
    const fieldArray = raw[i + 1];
    if (!Array.isArray(fieldArray)) continue;

    const map: Record<string, string> = {};
    for (let j = 0; j + 1 < fieldArray.length; j += 2) {
      const k = fieldArray[j];
      const v = fieldArray[j + 1];
      if (typeof k === 'string' && typeof v === 'string') map[k] = v;
    }

    const entry = hashToEntry(map);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ShortTermMemoryStore {
  private readonly hotLayer = new Map<string, STMEntry[]>();

  constructor(
    private readonly redis: Redis,
    private readonly embeddingCache: EmbeddingCache,
    private readonly config: STMHotConfig = DEFAULT_STM_HOT_CONFIG,
  ) {}

  // ── store ──────────────────────────────────────────────────────────────────

  /**
   * store — write to hot layer then warm Redis layer.
   *
   * Execution order:
   *   1. Hot layer push + evict oldest if window full (synchronous, zero I/O).
   *   2. Atomic INCR on session counter → StorageCapExceededError if cap exceeded
   *      (DECR fires-and-forgets before throw to compensate).
   *   3. Embed entry.summary via EmbeddingCache.
   *   4. HSET all fields including binary embedding, EXPIRE the hash key.
   *
   * Returns the assigned id.
   */
  async store(entry: Omit<STMEntry, 'id' | 'createdAt'>): Promise<string> {
    const id   = randomUUID();
    const full: STMEntry = { ...entry, id, createdAt: Date.now() };

    // ── 1. Hot layer ──────────────────────────────────────────────────────────
    const window = this.hotLayer.get(full.sessionId) ?? [];
    window.push(full);
    if (window.length > this.config.stmHotWindowSize) {
      window.shift(); // oldest evicted from hot; still exists in warm layer
    }
    this.hotLayer.set(full.sessionId, window);

    // ── 2. Atomic cap check ───────────────────────────────────────────────────
    const countKey = `stm-count:${full.tenantId}:${full.sessionId}`;
    const count    = await this.redis.incr(countKey);
    if (count > this.config.maxStmEntriesPerSession) {
      // Compensate the over-increment before throwing — fire-and-forget, must
      // not block. The throw happens in the same synchronous continuation.
      void this.redis.decr(countKey);
      throw new StorageCapExceededError(
        full.sessionId,
        `STM session '${full.sessionId}' (tenant '${full.tenantId}') has reached ` +
        `the cap of ${this.config.maxStmEntriesPerSession} entries.`,
      );
    }
    // Refresh counter TTL on every write so it expires with the session.
    await this.redis.expire(countKey, this.config.stmTtlSeconds);

    // ── 3. Embed ─────────────────────────────────────────────────────────────
    const embedding = await this.embeddingCache.embed(full.summary);

    // ── 4. HSET + EXPIRE ──────────────────────────────────────────────────────
    const entryKey = `stm:${full.tenantId}:${full.sessionId}:${full.id}`;
    await this.redis.hset(entryKey, {
      id:        full.id,
      tenantId:  full.tenantId,
      sessionId: full.sessionId,
      scope:     full.scope,
      summary:   full.summary,
      detail:    JSON.stringify(full.detail),
      tags:      JSON.stringify(full.relevanceTags),
      turnIndex: full.turnIndex,
      createdAt: full.createdAt,
      ...(full.userId !== undefined ? { userId: full.userId } : {}),
      embedding: Buffer.from(new Float32Array(embedding).buffer as ArrayBuffer),
    });
    await this.redis.expire(entryKey, this.config.stmTtlSeconds);

    return id;
  }

  // ── recallRecent ───────────────────────────────────────────────────────────

  /**
   * recallRecent — return the last `limit` entries from the hot layer, newest-last.
   * Synchronous — zero I/O. Returns [] if the session has no hot-layer entries.
   */
  recallRecent({ tenantId: _tenantId, sessionId, limit }: {
    tenantId:  string;
    sessionId: string;
    limit:     number;
  }): STMEntry[] {
    const window = this.hotLayer.get(sessionId);
    if (!window || window.length === 0) return [];
    return window.slice(-limit);
  }

  // ── recall ─────────────────────────────────────────────────────────────────

  /**
   * recall — warm-layer KNN vector search via Redis FT.SEARCH.
   *
   * Embeds `query`, issues a KNN search on stm-idx:{tenantId} with a @sessionId
   * TAG filter. Results are parsed from the FT.SEARCH response and returned as
   * STMEntry[]. Returns [] on any Redis or parse error — never throws.
   */
  async recall({ tenantId, sessionId, query, topK = 5 }: {
    tenantId:  string;
    sessionId: string;
    query:     string;
    topK?:     number;
  }): Promise<STMEntry[]> {
    try {
      const vector    = await this.embeddingCache.embed(query);
      const vecBuf    = Buffer.from(new Float32Array(vector).buffer as ArrayBuffer);
      const escaped   = escapeTag(sessionId);
      const indexName = `stm-idx:${tenantId}`;

      const raw = await this.redis.call(
        'FT.SEARCH',
        indexName,
        `(@sessionId:{${escaped}}) => [KNN ${topK} @embedding $vec AS knn_score]`,
        'PARAMS', '2', 'vec', vecBuf,
        'SORTBY', 'knn_score',
        'DIALECT', '2',
      ) as unknown[];

      return parseSearchResults(raw);
    } catch {
      // Redis Stack not available, index not yet created, or parse error.
      // Graceful degradation: return empty rather than surfacing an infrastructure error.
      return [];
    }
  }

  // ── destroySession ─────────────────────────────────────────────────────────

  /**
   * destroySession — remove all warm-layer entries for the session, delete the
   * session counter, then clear the hot layer.
   *
   * Uses SCAN (not KEYS) to avoid blocking Redis on large keyspaces.
   */
  async destroySession(tenantId: string, sessionId: string): Promise<void> {
    // Warm layer: SCAN for all entry hashes matching stm:{tenantId}:{sessionId}:*
    const pattern = `stm:${tenantId}:${sessionId}:*`;
    let cursor = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', pattern, 'COUNT', 100,
      );
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      cursor = parseInt(nextCursor, 10);
    } while (cursor !== 0);

    // Delete the session counter
    await this.redis.del(`stm-count:${tenantId}:${sessionId}`);

    // Hot layer: free in-process memory
    this.hotLayer.delete(sessionId);
  }
}
