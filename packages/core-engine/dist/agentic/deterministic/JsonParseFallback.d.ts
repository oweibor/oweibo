export interface ParseResult<T> {
    ok: true;
    value: T;
}
export interface ParseFailure {
    ok: false;
    reason: string;
    raw: string;
}
export type ParseOutcome<T> = ParseResult<T> | ParseFailure;
/**
 * Try to parse `text` as JSON and validate it with `guard`.
 * Returns a discriminated union — never throws.
 */
export declare function safeParse<T>(text: string, guard: (value: unknown) => value is T): ParseOutcome<T>;
/**
 * Parse and return the value, or return `fallback` on failure.
 */
export declare function parseOrFallback<T>(text: string, guard: (value: unknown) => value is T, fallback: T): T;
/**
 * Unwrap a JSON array, returning an empty array if parsing fails.
 * Used by GoalDecomposer-style callers where an array is always expected.
 */
export declare function parseJsonArray<T>(text: string, itemGuard: (item: unknown) => item is T): T[];
/**
 * Repair common LLM JSON serialisation mistakes:
 *   - Trailing commas before ] or }
 *   - Single-quoted strings (naïve replacement — doesn't handle embedded quotes)
 *   - Unquoted keys
 */
export declare function repairJson(text: string): string;
/**
 * Try parsing as-is; if that fails, try repairJson() first.
 * Returns null if both attempts fail.
 */
export declare function parseWithRepair<T>(text: string, guard: (v: unknown) => v is T): T | null;
//# sourceMappingURL=JsonParseFallback.d.ts.map