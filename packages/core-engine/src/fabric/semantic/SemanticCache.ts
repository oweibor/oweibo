/**
 * K.5 — SemanticCache: the running permission-aware result cache that ARMS
 * the ADR-001 §3.6 contract (shipped green at K.4 as pure predicates). It
 * reuses those predicates verbatim — `deriveCacheKey` (INV-13: the key
 * STRUCTURALLY contains the canonical identity, so a cross-identity hit is
 * impossible by construction) and `isCacheable` (INV-3: Critical is never
 * cached) — so the cache cannot drift from the contract it implements.
 *
 * The §7.7 eligibility rules this layer adds on top of the two predicates:
 *   • event invalidation — IndexUpdated/ACLUpdated (by document) and
 *     MembershipChanged (by group) drop every entry that contributed doc/group;
 *   • heartbeat-silence SUSPENSION — a contributing connector silent past its
 *     own `heartbeatSeconds` means the ABSENCE of an invalidation event carries
 *     no information (a Degraded/Throttled connector stops emitting), so the
 *     entry is suspended (NOT served, NOT deleted) until the connector is live
 *     again — the §6.6 fail-closed mirror;
 *   • TTL by strictest contributing freshness class (§5.2).
 *
 * Backend is an in-process Map for K.5 (deterministic, CI-safe). Production
 * Redis is a drop-in behind the same surface — the O(n) invalidation scan is
 * the one place that gains a secondary index there; noted, not built here.
 */

import {
  deriveCacheKey,
  isCacheable,
  type CacheKeyInput,
  type FreshnessClass,
} from '../planner/contract.js';

/** TTL by freshness class (§5.2 / ADR-001 §6). Static never expires; Critical is uncacheable. */
export const CACHE_TTL_MS: Readonly<Record<FreshnessClass, number>> = {
  static: Number.POSITIVE_INFINITY,
  operational: 15 * 60 * 1000,
  transactional: 60 * 1000,
  critical: 0, // never stored (isCacheable === false)
};

export interface ContributingConnector {
  readonly connectorId: string;
  /** The connector's declared liveness interval (§10.1). */
  readonly heartbeatSeconds: number;
}

export interface CachePutInput {
  readonly keyInput: CacheKeyInput;
  /** The cited response to cache (opaque to the cache). */
  readonly payload: unknown;
  /** Strictest freshness class among contributing fields — sets TTL + cacheability. */
  readonly strictestClass: FreshnessClass;
  /** Docs whose IndexUpdated/ACLUpdated invalidates this entry. */
  readonly contributingDocumentIds: readonly string[];
  /** Groups whose MembershipChanged invalidates this entry. */
  readonly contributingGroupRefs: readonly string[];
  readonly contributingConnectors: readonly ContributingConnector[];
  /** Write time; defaults to now. Injectable for deterministic tests. */
  readonly nowMs?: number;
}

interface CacheEntry {
  readonly payload: unknown;
  readonly strictestClass: FreshnessClass;
  readonly writtenAtMs: number;
  readonly documentIds: ReadonlySet<string>;
  readonly groupRefs: ReadonlySet<string>;
  readonly connectors: readonly ContributingConnector[];
}

export type CacheLookup =
  | { readonly status: 'hit'; readonly payload: unknown }
  | { readonly status: 'miss' }
  | { readonly status: 'suspended'; readonly connectorId: string };

export interface CacheGetOptions {
  /** Per-connector last-heartbeat timestamps (owned by the scheduler/lifecycle). */
  readonly connectorLastHeartbeatMs: Readonly<Record<string, number>>;
  readonly nowMs?: number;
}

export interface InvalidationEvent {
  readonly subject: 'IndexUpdated' | 'ACLUpdated' | 'MembershipChanged';
  /** IndexUpdated / ACLUpdated. */
  readonly documentId?: string;
  /** MembershipChanged. */
  readonly affectedGroupRefs?: readonly string[];
}

export class SemanticCache {
  private readonly store = new Map<string, CacheEntry>();

  /**
   * Store a result — but only if cacheable (INV-3: Critical is refused).
   * Returns whether the entry was stored, so callers can assert Critical was
   * never written.
   */
  put(input: CachePutInput): boolean {
    if (!isCacheable(input.strictestClass)) return false;
    const key = deriveCacheKey(input.keyInput);
    this.store.set(key, {
      payload: input.payload,
      strictestClass: input.strictestClass,
      writtenAtMs: input.nowMs ?? Date.now(),
      documentIds: new Set(input.contributingDocumentIds),
      groupRefs: new Set(input.contributingGroupRefs),
      connectors: input.contributingConnectors,
    });
    return true;
  }

  /**
   * Look up an entry. A cross-identity request derives a DIFFERENT key
   * (INV-13) and therefore misses — the guarantee is in the key, not a
   * post-filter. A contributing connector silent past its heartbeat suspends
   * the entry (§7.7). An expired entry (age > class TTL) misses.
   */
  get(keyInput: CacheKeyInput, opts: CacheGetOptions): CacheLookup {
    const key = deriveCacheKey(keyInput);
    const entry = this.store.get(key);
    if (!entry) return { status: 'miss' };

    const now = opts.nowMs ?? Date.now();

    // Heartbeat-silence suspension (§7.7 / §6.6 fail-closed mirror).
    for (const conn of entry.connectors) {
      const last = opts.connectorLastHeartbeatMs[conn.connectorId];
      const silentForMs = last === undefined ? Number.POSITIVE_INFINITY : now - last;
      if (silentForMs > conn.heartbeatSeconds * 1000) {
        return { status: 'suspended', connectorId: conn.connectorId };
      }
    }

    // TTL by strictest contributing class.
    const ttl = CACHE_TTL_MS[entry.strictestClass];
    if (now - entry.writtenAtMs > ttl) {
      this.store.delete(key);
      return { status: 'miss' };
    }

    return { status: 'hit', payload: entry.payload };
  }

  /**
   * Apply an invalidation event (§7.7). IndexUpdated/ACLUpdated drop every
   * entry that cited the document; MembershipChanged drops every entry whose
   * audience touched an affected group. Returns the count dropped.
   */
  invalidate(event: InvalidationEvent): number {
    let dropped = 0;
    for (const [key, entry] of this.store) {
      const hit =
        (event.documentId !== undefined && entry.documentIds.has(event.documentId)) ||
        (event.affectedGroupRefs !== undefined &&
          event.affectedGroupRefs.some((g) => entry.groupRefs.has(g)));
      if (hit) {
        this.store.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Entry count — for tests and observability. */
  size(): number {
    return this.store.size;
  }
}
