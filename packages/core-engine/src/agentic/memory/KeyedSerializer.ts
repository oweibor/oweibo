/**
 * KeyedSerializer — serialises async work by key. Calls keyed by the same
 * value run sequentially in arrival order; calls keyed by different values
 * run concurrently.
 *
 * Used by QdrantSemanticStore to fix two in-process races:
 *
 *   #11 TOCTOU on cap check — concurrent stores for the same tenant could
 *       both read points_count=99_999 and both upsert, exceeding the cap.
 *       Per-tenant serialisation makes the (cap-check + upsert) atomic
 *       within one process.
 *
 *   #12 Racy reinforcement — concurrent recalls of the same point could
 *       both retrieve recall_count=5 and both setPayload(6), losing one
 *       increment. Per-point serialisation closes the read-modify-write
 *       window within one process.
 *
 * NOT a cross-process lock. For multi-replica deployments, take Qdrant's
 * own concurrency at face value (cap is soft; reinforcement is best-effort).
 */
export class KeyedSerializer<K> {
  private readonly chains = new Map<K, Promise<unknown>>();

  /**
   * Run `fn` after any pending work for `key` finishes. Returns whatever
   * `fn` returns (or throws what `fn` throws). The chain itself is
   * isolated from `fn`'s failure: a thrown call doesn't break subsequent
   * calls for the same key.
   */
  async chain<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // .catch(()=>undefined) ensures a failed predecessor doesn't poison
    // the chain — the next caller still gets to run.
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    try {
      return await next;
    } finally {
      // Drop the entry once we're the latest, so the map doesn't grow.
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }

  /** Number of keys currently holding a queued chain. Useful for tests. */
  get pendingKeys(): number {
    return this.chains.size;
  }
}
