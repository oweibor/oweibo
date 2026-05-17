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
export declare class KeyedSerializer<K> {
    private readonly chains;
    /**
     * Run `fn` after any pending work for `key` finishes. Returns whatever
     * `fn` returns (or throws what `fn` throws). The chain itself is
     * isolated from `fn`'s failure: a thrown call doesn't break subsequent
     * calls for the same key.
     */
    chain<T>(key: K, fn: () => Promise<T>): Promise<T>;
    /** Number of keys currently holding a queued chain. Useful for tests. */
    get pendingKeys(): number;
}
//# sourceMappingURL=KeyedSerializer.d.ts.map