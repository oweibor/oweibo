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
 */
import type { LongTermMemoryStore, MemoryEntry } from './LongTermMemoryStore.js';
import type { ShortTermMemoryStore, STMEntry } from './ShortTermMemoryStore.js';
export interface WarmResult {
    entry: MemoryEntry | STMEntry;
    score: number;
    source: 'ltm' | 'stm';
}
export declare class MemoryWarmer {
    private readonly ltm;
    private readonly stm;
    constructor(ltm: LongTermMemoryStore, stm: ShortTermMemoryStore);
    /**
     * warmForTask — assemble the warm-memory block for a task.
     *
     * @param tenantId        — tenant for Qdrant collection scoping
     * @param sessionId       — STM session to recall from
     * @param agentScope      — '{role}:{taskId}' LTM scope for agent-specific memories
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