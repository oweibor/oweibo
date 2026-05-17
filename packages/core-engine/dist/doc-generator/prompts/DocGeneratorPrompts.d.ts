/**
 * DocGeneratorPrompts — all LLM prompts for the doc-generator pipeline.
 *
 * Prompts are registered in Langfuse by scripts/seed-prompts-doc-generator.ts
 * with versioned keys: doc-generator/<phase>-system.
 *
 * All prompts instruct the LLM to return structured JSON so downstream
 * parsers can validate and fall back gracefully.
 */
export declare const DOC_GEN_PHASES: {
    readonly PROJECT_SUMMARY: "doc-project-summary";
    readonly MODULE_DESC: "doc-module-desc";
    readonly ADR_INFER: "doc-adr-infer";
    readonly CONVENTIONS: "doc-conventions";
    readonly DEP_PURPOSE: "doc-dep-purpose";
    readonly GETTING_STARTED: "doc-getting-started";
};
export type DocGenPhase = typeof DOC_GEN_PHASES[keyof typeof DOC_GEN_PHASES];
export declare const PROJECT_SUMMARY_SYSTEM_PROMPT: string;
export declare const PROJECT_SUMMARY_USER_PROMPT: (context: string) => string;
export declare const MODULE_DESC_SYSTEM_PROMPT: string;
export declare const MODULE_DESC_USER_PROMPT: (moduleName: string, apiContext: string) => string;
export declare const ADR_INFER_SYSTEM_PROMPT: string;
export declare const ADR_INFER_USER_PROMPT: (evidence: string) => string;
export declare const CONVENTIONS_SYSTEM_PROMPT: string;
export declare const CONVENTIONS_USER_PROMPT: (context: string) => string;
export declare const DEP_PURPOSE_SYSTEM_PROMPT: string;
export declare const DEP_PURPOSE_USER_PROMPT: (packages: readonly string[]) => string;
export declare const GETTING_STARTED_SYSTEM_PROMPT: string;
export declare const GETTING_STARTED_USER_PROMPT: (context: string) => string;
export declare const PHASE_TOKEN_BUDGETS: Record<DocGenPhase, {
    input: number;
    output: number;
}>;
export declare const GLOBAL_TOKEN_BUDGET = 80000;
//# sourceMappingURL=DocGeneratorPrompts.d.ts.map