"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryWarmer = void 0;
// ─── Score normalisation constants ────────────────────────────────────────────
// These are fixed scale factors, not config — changing them requires understanding
// the composite scoring formula in LongTermMemoryStore.recall().
const AGENT_BOOST = 0.10;
const PROJECT_BOOST = 0.08;
const STM_BOOST = 0.05;
const STM_SCALE = 0.60; // maps cosine [0,1] onto the LTM composite range
const STM_OFFSET = 0.25; // recency credit for in-session entries
// ─── Warmer ───────────────────────────────────────────────────────────────────
class MemoryWarmer {
    ltm;
    stm;
    constructor(ltm, stm) {
        this.ltm = ltm;
        this.stm = stm;
    }
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
    async warmForTask(params) {
        const { tenantId, sessionId, agentScope, taskDescription, projectId, topK = 6, } = params;
        // ── Four parallel recall channels ─────────────────────────────────────────
        const [agentResults, projectResults, stmResults, tenantResults] = await Promise.all([
            this.ltm.recall(tenantId, taskDescription, { scope: agentScope, topK }),
            projectId
                ? this.ltm.recall(tenantId, taskDescription, { scope: `project:${projectId}`, topK })
                : Promise.resolve([]),
            this.stm.recall({ tenantId, sessionId, query: taskDescription, topK }),
            this.ltm.recall(tenantId, taskDescription, { scope: `tenant:${tenantId}`, topK }),
        ]);
        // ── Map each source to WarmResult[] with normalised scores ────────────────
        const agentWarm = agentResults.map(r => ({
            entry: r.entry,
            score: r.score + AGENT_BOOST,
            source: 'ltm',
        }));
        const projectWarm = projectResults.map(r => ({
            entry: r.entry,
            score: r.score + PROJECT_BOOST,
            source: 'ltm',
        }));
        const tenantWarm = tenantResults.map(r => ({
            entry: r.entry,
            score: r.score,
            source: 'ltm',
        }));
        // STM entries don't expose their KNN score; use cosineScore = 1.0 (all
        // returned entries passed the KNN filter and are considered fully relevant).
        const stmWarm = stmResults.map(entry => ({
            entry,
            score: STM_SCALE * 1.0 + STM_OFFSET + STM_BOOST,
            source: 'stm',
        }));
        // ── Merge, sort, deduplicate, slice ───────────────────────────────────────
        const all = [...agentWarm, ...projectWarm, ...stmWarm, ...tenantWarm];
        // Sort descending by score first so that when we deduplicate we always keep
        // the highest-scored occurrence of each summary.
        all.sort((a, b) => b.score - a.score);
        // Deduplicate by entry.summary string equality.
        // Same semantic content can appear in multiple channels (original vs promoted
        // copy), and ids diverge between them while summaries remain identical.
        const seen = new Set();
        const deduped = all.filter(r => {
            const fp = r.entry.summary;
            if (seen.has(fp))
                return false;
            seen.add(fp);
            return true;
        });
        return deduped.slice(0, topK);
    }
}
exports.MemoryWarmer = MemoryWarmer;
//# sourceMappingURL=MemoryWarmer.js.map