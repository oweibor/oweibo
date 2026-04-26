import type { ILLMClient } from '@oweibo/core-contracts';
type QdrantClient = any;
/**
 * ProjectRulesLoader — loads and synthesises project-level coding rules.
 *
 * Sources (priority order, highest first):
 *   1. .oweibo/rules.md     — explicit oweibo rules file
 *   2. CLAUDE.md            — Claude Code compatibility
 *   3. .cursorrules         — Cursor AI compatibility
 *   4. Auto-extracted conventions — inferred from codebase on first index
 *
 * v9.1 security fix: Rules files are limited to 100KB to prevent prompt injection via
 * oversized rules. Content is truncated to 4000 chars (~1000 tokens) for the LLM context.
 */
export declare class ProjectRulesLoader {
    private readonly llm;
    private readonly qdrant;
    private static readonly RULES_FILES;
    private static readonly MAX_FILE_SIZE_BYTES;
    private static readonly MAX_CONTENT_CHARS;
    private static readonly MAX_TOTAL_TOKENS;
    constructor(llm: ILLMClient, qdrant: QdrantClient);
    load(repoRoot: string): Promise<string>;
    /**
     * v9.1: Check for suspicious patterns that might indicate prompt injection.
     * These patterns don't block loading but trigger a warning.
     */
    private containsSuspiciousPatterns;
    /**
     * v9.1: Enforce token budget by truncating to MAX_TOTAL_TOKENS.
     * Uses simple word-count heuristic (1 token ≈ 0.75 words).
     */
    private enforceTokenBudget;
    /**
     * extractConventions — samples TypeScript files and asks the LLM to identify
     * coding conventions. Called once per repo root and cached.
     */
    private extractConventions;
    private sampleSourceFiles;
}
export {};
//# sourceMappingURL=ProjectRulesLoader.d.ts.map