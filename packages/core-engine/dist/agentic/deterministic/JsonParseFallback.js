"use strict";
// DONE: Phase A.11 — deterministic JSON parsing with structured fallbacks.
// Pure functions only — zero LLM calls, zero I/O.
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeParse = safeParse;
exports.parseOrFallback = parseOrFallback;
exports.parseJsonArray = parseJsonArray;
exports.repairJson = repairJson;
exports.parseWithRepair = parseWithRepair;
/**
 * Try to parse `text` as JSON and validate it with `guard`.
 * Returns a discriminated union — never throws.
 */
function safeParse(text, guard) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        // If the model wrapped JSON in a markdown code fence, try to extract it.
        const extracted = extractJsonBlock(text);
        if (extracted !== null) {
            try {
                parsed = JSON.parse(extracted);
            }
            catch {
                return { ok: false, reason: `JSON.parse failed: ${String(err)}`, raw: text };
            }
        }
        else {
            return { ok: false, reason: `JSON.parse failed: ${String(err)}`, raw: text };
        }
    }
    if (!guard(parsed)) {
        return {
            ok: false,
            reason: `Shape validation failed: received ${JSON.stringify(parsed).slice(0, 200)}`,
            raw: text,
        };
    }
    return { ok: true, value: parsed };
}
/**
 * Parse and return the value, or return `fallback` on failure.
 */
function parseOrFallback(text, guard, fallback) {
    const result = safeParse(text, guard);
    return result.ok ? result.value : fallback;
}
/**
 * Unwrap a JSON array, returning an empty array if parsing fails.
 * Used by GoalDecomposer-style callers where an array is always expected.
 */
function parseJsonArray(text, itemGuard) {
    const isArrayOfT = (v) => Array.isArray(v) && v.every(itemGuard);
    const result = safeParse(text, isArrayOfT);
    return result.ok ? result.value : [];
}
/**
 * Extract a JSON block from a markdown code fence, if present.
 * Handles ```json ... ``` and ``` ... ``` patterns.
 * Returns null if no code fence is found.
 */
function extractJsonBlock(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? (match[1] ?? '').trim() : null;
}
/**
 * Repair common LLM JSON serialisation mistakes:
 *   - Trailing commas before ] or }
 *   - Single-quoted strings (naïve replacement — doesn't handle embedded quotes)
 *   - Unquoted keys
 */
function repairJson(text) {
    return text
        .replace(/,\s*([}\]])/g, '$1') // trailing commas
        .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":'); // single-quoted keys
}
/**
 * Try parsing as-is; if that fails, try repairJson() first.
 * Returns null if both attempts fail.
 */
function parseWithRepair(text, guard) {
    const direct = safeParse(text, guard);
    if (direct.ok)
        return direct.value;
    const repaired = safeParse(repairJson(text), guard);
    return repaired.ok ? repaired.value : null;
}
//# sourceMappingURL=JsonParseFallback.js.map