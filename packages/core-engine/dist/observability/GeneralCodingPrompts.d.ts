/**
 * GeneralCodingPrompts — Langfuse-seeded prompts for general-coding operations (§22.3).
 *
 * Provides system prompts for all roles in the general-coding path:
 * code editing, refactoring, debugging, test writing, documentation,
 * and commit message generation. Falls back to bundled defaults when
 * Langfuse is unavailable.
 *
 * Integrated with PromptRegistry — call seedGeneralCodingPrompts() at startup.
 */
/** All named prompts for the general-coding path */
export declare const GENERAL_CODING_PROMPTS: Record<string, string>;
/** Register all general-coding prompts into the PromptRegistry at startup */
export declare function getGeneralCodingPromptNames(): string[];
/** Retrieve a bundled general-coding prompt by name */
export declare function getGeneralCodingPrompt(name: string): string | undefined;
//# sourceMappingURL=GeneralCodingPrompts.d.ts.map