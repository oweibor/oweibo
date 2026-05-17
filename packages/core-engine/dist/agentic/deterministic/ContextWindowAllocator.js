"use strict";
// DONE: Phase A.11 — deterministic context-window token-budget allocation.
// Pure functions only — zero LLM calls, zero I/O.
Object.defineProperty(exports, "__esModule", { value: true });
exports.allocateTokenBudget = allocateTokenBudget;
exports.estimateTokens = estimateTokens;
exports.truncateToTokenBudget = truncateToTokenBudget;
/**
 * Trim priority order (lower index = trimmed first):
 *   1. conversationHistory  — oldest turns first
 *   2. skills               — truncate from end
 *   3. projectRules         — truncate from end
 *   4. repoMap              — truncate from end
 *   5. systemPrompt + userInstruction are never trimmed
 */
function allocateTokenBudget(input) {
    const budget = input.contextWindowTokens - input.reservedForGeneration;
    const fixed = input.systemPromptTokens +
        input.userInstructionTokens;
    let remaining = budget - fixed;
    let conversationHistory = input.conversationHistoryTokens;
    let skills = input.skillsTokens;
    let projectRules = input.projectRulesTokens;
    let repoMap = input.repoMapTokens;
    const trim = (component, available) => {
        const used = Math.min(component, Math.max(0, available));
        const trimmed = component - used;
        return [used, trimmed];
    };
    let trimmedHistory = 0, trimmedSkills = 0, trimmedRules = 0, trimmedMap = 0;
    // Compute total excess across all variable components and trim in priority order.
    const totalRequested = conversationHistory + skills + projectRules + repoMap;
    let excess = Math.max(0, totalRequested - remaining);
    const clamp = (component, amount) => {
        const t = Math.min(component, amount);
        return [component - t, t];
    };
    [conversationHistory, trimmedHistory] = clamp(conversationHistory, excess);
    excess -= trimmedHistory;
    [skills, trimmedSkills] = clamp(skills, excess);
    excess -= trimmedSkills;
    [projectRules, trimmedRules] = clamp(projectRules, excess);
    excess -= trimmedRules;
    [repoMap, trimmedMap] = clamp(repoMap, excess);
    const totalUsed = input.systemPromptTokens +
        input.userInstructionTokens +
        conversationHistory + skills + projectRules + repoMap;
    return {
        allocation: {
            systemPrompt: input.systemPromptTokens,
            repoMap,
            projectRules,
            skills,
            conversationHistory,
            userInstruction: input.userInstructionTokens,
            reservedForGeneration: input.reservedForGeneration,
        },
        trimmed: {
            systemPrompt: 0,
            repoMap: trimmedMap,
            projectRules: trimmedRules,
            skills: trimmedSkills,
            conversationHistory: trimmedHistory,
            userInstruction: 0,
        },
        totalUsed,
        overBudget: totalUsed > budget,
    };
}
/**
 * Estimate token count from a string using the ~4 chars/token heuristic.
 * Suitable for budgeting decisions; not a substitute for a proper tokenizer.
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Truncate text so its estimated token count fits within maxTokens.
 * Preserves leading content (head truncation).
 */
function truncateToTokenBudget(text, maxTokens) {
    const maxChars = maxTokens * 4;
    return text.length <= maxChars ? text : text.slice(0, maxChars);
}
//# sourceMappingURL=ContextWindowAllocator.js.map