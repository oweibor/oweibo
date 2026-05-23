/**
 * MemoryWarmer — assembles the warm-memory block injected into agent system prompts.
 *
 * Fires four parallel recall channels and merges them into a single ranked list:
 *   1. LTM agent scope  — memories specific to this agent role + task
 *   2. LTM project scope — project-level conventions and decisions (when projectId supplied)
 *   3. STM in-session   — recent turns from the warm Redis VSS layer
 *   4. LTM tenant scope — promoted tenant-wide procedural knowledge
 *
 * Score normalisation ensures LTM composite scores (0–1.3+) and STM raw cosine
 * scores (0–1) are brought onto a comparable scale before merging:
 *
 *   LTM agent:   score = r.score + AGENT_BOOST   (0.10 proximity bonus)
 *   LTM project: score = r.score + PROJECT_BOOST (0.08 proximity bonus)
 *   LTM tenant:  score = r.score                 (baseline — no boost)
 *   STM:         score = STM_SCALE × cosine + STM_OFFSET + STM_BOOST
 *                      = 0.60 × 1.0 + 0.25 + 0.05 = 0.90 (default)
 *
 * STM entries from the recall channel do not expose their KNN score, so
 * cosineScore defaults to 1.0 — all returned STM entries passed the KNN
 * filter and are treated as fully relevant; recency credit comes from
 * STM_OFFSET and role specificity from STM_BOOST.
 *
 * Deduplication: by entry.summary string equality — not by entry.id.
 * The same semantic memory can appear in multiple channels (e.g. agent scope
 * and tenant scope after MemoryScopePromoter runs); ids diverge between the
 * original and promoted copy but summaries match.
 *
 * Token truncation is NOT performed here — that is PromptBudgetEnforcer's job.
 *
 * Phase 2b: Migrated from legacy LongTermMemoryStore to ISemanticMemoryStore.
 */
import type { ISemanticMemoryStore, RankedMemoryEntry, IPlatformLessonRecall } from '@oweibo/core-contracts';
import type { ShortTermMemoryStore, STMEntry } from './ShortTermMemoryStore.js';
export interface WarmResult {
    entry: RankedMemoryEntry | STMEntry | PlatformLessonEntry;
    score: number;
    source: 'ltm' | 'stm' | 'platform';
}
/**
 * T.4: a platform-lesson hit reshaped for the WarmResult union. The
 * MemoryWarmer never re-attributes the lesson to a tenant; the [platform]
 * marker is added downstream in prompt assembly.
 */
export interface PlatformLessonEntry {
    readonly id: string;
    readonly summary: string;
    readonly body?: string;
    /** Tagged so the suppression filter still treats it like any other entry. */
    readonly tags: readonly string[];
    readonly source: 'platform-lesson';
}
export declare class MemoryWarmer {
    private readonly ltm;
    private readonly stm;
    /** T.4: optional fifth channel; omit to preserve four-channel behavior. */
    private readonly platformLessons?;
    constructor(ltm: ISemanticMemoryStore, stm: ShortTermMemoryStore, 
    /** T.4: optional fifth channel; omit to preserve four-channel behavior. */
    platformLessons?: IPlatformLessonRecall | undefined);
    /**
     * warmForTask — assemble the warm-memory block for a task.
     *
     * @param tenantId        — tenant for Qdrant collection scoping
     * @param sessionId       — STM session to recall from
     * @param agentScope      — '{role}:{taskId}' — unused in contract API (kept for compat)
     * @param taskDescription — query text for all four recall channels
     * @param projectId       — optional project; enables the project scope channel
     * @param topK            — entries per channel AND final slice (default: 6)
     */
    warmForTask(params: {
        tenantId: string;
        sessionId: string;
        agentScope: string;
        taskDescription: string;
        projectId?: string;
        maxTokens?: number;
        topK?: number;
    }): Promise<WarmResult[]>;
}
//# sourceMappingURL=MemoryWarmer.d.ts.map