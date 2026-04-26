"use strict";
/**
 * PromptBudgetEnforcer — assembles and token-budgets agent system prompts.
 *
 * Two orderings to keep distinct:
 *
 *   EVICTION order (what gets dropped first under budget pressure):
 *     repoMap → conversationHistory → warmMemory → skills → projectRules
 *
 *   ASSEMBLY order (position in the final prompt string):
 *     systemPrompt → userProfile → projectRules → skills →
 *     warmMemory → conversationHistory → repoMap
 *
 * These are inverses: the lowest-value component (repoMap) is evicted first
 * and assembled last. systemPrompt and userProfile are protected — they are
 * neither truncated nor evicted regardless of budget pressure.
 *
 * Partial fit: when a component's token count exceeds the remaining budget but
 * some budget is still available, the component is character-sliced to fit and
 * truncationSuffix is appended. The component name is recorded in truncations[].
 *
 * Token counting: Math.ceil(text.length / 4) — character heuristic,
 * consistent with the project-wide pattern (no tokenizer available here).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptBudgetEnforcer = exports.DEFAULT_BUDGET_CONFIG = void 0;
exports.DEFAULT_BUDGET_CONFIG = {
    maxTotalTokens: 120_000,
    reservedForCompletion: 8_000,
    truncationSuffix: '\n[truncated by PromptBudgetEnforcer]',
};
// ─── Enforcer ─────────────────────────────────────────────────────────────────
class PromptBudgetEnforcer {
    config;
    constructor(config = exports.DEFAULT_BUDGET_CONFIG) {
        this.config = config;
    }
    // ── Token counting ────────────────────────────────────────────────────────
    countTokens(text) {
        return Math.ceil(text.length / 4);
    }
    // ── Public API ────────────────────────────────────────────────────────────
    /**
     * enforce — fit prompt components within the token budget and assemble.
     *
     * Protected (never evicted): systemPrompt, userProfile.
     * Eviction order: repoMap → conversationHistory → warmMemory → skills → projectRules.
     * Assembly order: systemPrompt → userProfile → projectRules → skills →
     *                 warmMemory → conversationHistory → repoMap.
     */
    enforce(components) {
        const truncations = [];
        // ── Step 1: compute available budget ─────────────────────────────────────
        let remaining = this.config.maxTotalTokens - this.config.reservedForCompletion;
        // ── Step 2: deduct protected components ──────────────────────────────────
        // systemPrompt and userProfile are always included without truncation.
        remaining -= this.countTokens(components.systemPrompt);
        if (components.userProfile) {
            remaining -= this.countTokens(components.userProfile);
        }
        // ── Step 3 & 4: fit evictable components in eviction order ───────────────
        // Try each component; if it fits, deduct; if it partially fits, truncate;
        // if budget is exhausted, evict (undefined → excluded from assembly).
        const fit = (key, text) => {
            if (text === undefined)
                return undefined;
            const needed = this.countTokens(text);
            if (needed <= remaining) {
                remaining -= needed;
                return text;
            }
            if (remaining > 0) {
                // Partial fit: slice to remaining budget and append suffix.
                const charBudget = remaining * 4;
                const truncated = text.slice(0, charBudget) + this.config.truncationSuffix;
                remaining = 0;
                truncations.push(key);
                return truncated;
            }
            // No budget left — evict entirely.
            return undefined;
        };
        // Eviction order: repoMap → conversationHistory → warmMemory → skills → projectRules
        const repoMap = fit('repoMap', components.repoMap);
        const conversationHistory = fit('conversationHistory', components.conversationHistory);
        const warmMemory = fit('warmMemory', components.warmMemory);
        const skills = fit('skills', components.skills);
        const projectRules = fit('projectRules', components.projectRules);
        // ── Step 5: assemble in prompt order ─────────────────────────────────────
        // Assembly order is the inverse of eviction priority:
        //   systemPrompt → userProfile → projectRules → skills →
        //   warmMemory → conversationHistory → repoMap
        const parts = [components.systemPrompt];
        if (components.userProfile)
            parts.push(components.userProfile);
        if (projectRules)
            parts.push(projectRules);
        if (skills)
            parts.push(skills);
        if (warmMemory)
            parts.push(warmMemory);
        if (conversationHistory)
            parts.push(conversationHistory);
        if (repoMap)
            parts.push(repoMap);
        const assembled = parts.join('\n\n');
        // ── Step 6: return result ─────────────────────────────────────────────────
        return {
            assembled,
            totalTokens: this.countTokens(assembled),
            truncations,
        };
    }
}
exports.PromptBudgetEnforcer = PromptBudgetEnforcer;
//# sourceMappingURL=PromptBudgetEnforcer.js.map