/**
 * MemoryConsolidator — scheduled background job that clusters recent episodic
 * memories by shared relevance tags and synthesises each cluster into a single
 * tenant-wide semantic entry.
 *
 * R-11 fix: each entry is bucketed under ALL of its relevanceTags, not just
 * the first one. This means a memory tagged ['typescript', 'auth'] contributes
 * to both the 'typescript' cluster and the 'auth' cluster, so cross-cutting
 * insights are not lost.
 *
 * Consolidation pipeline per cluster:
 *   1. summariseCluster() — LLM call (stubbed; wire ModelRouter in §9).
 *   2. Parse JSON response, stripping ```json fences.
 *   3. qdrant.upsert() — write new tier:'semantic' / type:'domain-knowledge' point.
 *   4. Fire-and-forget setPayload() on all source entries setting consolidatedAt,
 *      preventing them from being reprocessed in future cycles.
 *
 * Retry: summariseCluster() failures retry once; if both attempts fail the
 * cluster is skipped without writing consolidatedAt (safe to retry next cycle).
 *
 * Concurrency: up to config.maxConcurrentTenants tenants in parallel (p-limit v3).
 */
import type { Logger } from './MemoryDecayService.js';
type QdrantClient = any;
export interface ConsolidatorConfig {
    windowDays: number;
    minClusterSize: number;
    maxClustersPerCycle: number;
    maxConcurrentTenants: number;
}
export declare const DEFAULT_CONSOLIDATOR_CONFIG: ConsolidatorConfig;
export declare class MemoryConsolidator {
    private readonly qdrant;
    private readonly config;
    private readonly tenantIds;
    private readonly logger;
    constructor(qdrant: QdrantClient, config: ConsolidatorConfig, tenantIds: () => Promise<string[]>, logger: Logger);
    /**
     * runConsolidationCycle — iterate over all tenants and consolidate each one.
     * Uses p-limit to cap concurrency at config.maxConcurrentTenants.
     */
    runConsolidationCycle(): Promise<void>;
    /**
     * consolidateTenant — scroll for unconsolidated episodic entries within the
     * time window, cluster them by tag, and consolidate qualifying clusters.
     */
    private consolidateTenant;
    /**
     * clusterByTags — bucket entries by each of their relevanceTags.
     *
     * R-11 fix: a memory tagged ['typescript', 'auth'] is pushed into BOTH the
     * 'typescript' bucket and the 'auth' bucket. Using only tags[0] would miss
     * cross-cutting signals.
     */
    private clusterByTags;
    /**
     * consolidateCluster — synthesise a tag cluster into a single semantic entry.
     *
     * summariseCluster() is attempted up to twice. Both failures → skip cluster
     * without writing consolidatedAt (safe to retry on the next cycle).
     * JSON parse failures after both attempts → same skip-and-warn behaviour.
     */
    private consolidateCluster;
    /**
     * summariseCluster — produce a JSON summary for a cluster of episodic entries.
     *
     * // TODO: wire ModelRouter (§9) — replace stub body with a structured LLM call
     * // that returns JSON { summary: string } describing what the cluster represents.
     */
    private summariseCluster;
}
export {};
//# sourceMappingURL=MemoryConsolidator.d.ts.map