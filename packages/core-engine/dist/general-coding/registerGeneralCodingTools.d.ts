/**
 * registerGeneralCodingTools — registers the 5 general-coding tool handlers
 * into the infrastructure ToolRegistry (§22.5).
 *
 * Tools registered:
 *   1. gc:edit      — propose and apply targeted file edits
 *   2. gc:run-tests — run the project test suite in the sandbox
 *   3. gc:search    — semantic search over the indexed repo
 *   4. gc:git       — git operations (diff, log, status, commit-message)
 *   5. gc:skill     — activate or deactivate a SKILL.md file
 *
 * Each tool handler validates inputs, executes via the appropriate service,
 * and returns a structured result. All calls are rate-checked by AnomalyDetector.
 */
import type { ILLMClient } from '@oweibo/core-contracts';
import type { GitAdapter } from './git/GitAdapter.js';
import type { SkillRegistry } from './project/SkillRegistry.js';
import type { EditApplicator } from './editing/EditApplicator.js';
import type { VerificationRunner } from './editing/VerificationRunner.js';
import type { GeneralRepoIndexer } from './intelligence/GeneralRepoIndexer.js';
export interface ToolInput {
    readonly toolName: string;
    readonly params: Record<string, unknown>;
    readonly taskId: string;
    readonly tenantId: string;
}
export interface ToolResult {
    readonly toolName: string;
    readonly success: boolean;
    readonly output: unknown;
    readonly errorMessage?: string;
    readonly durationMs: number;
}
export type ToolHandler = (input: ToolInput) => Promise<ToolResult>;
export interface ToolRegistry {
    register(name: string, handler: ToolHandler): void;
    get(name: string): ToolHandler | undefined;
    list(): string[];
}
export interface GeneralCodingToolDeps {
    editApplicator: EditApplicator;
    verifier: VerificationRunner;
    indexer: GeneralRepoIndexer;
    git: GitAdapter;
    skillRegistry: SkillRegistry;
    llm: ILLMClient;
    /** Absolute path to the repository root — required for sandbox and git ops */
    repoRoot: string;
}
/**
 * Register all 5 general-coding tools into the provided ToolRegistry.
 *
 * @example
 * ```ts
 * const registry = new InMemoryToolRegistry();
 * registerGeneralCodingTools(registry, deps);
 * const handler = registry.get('gc:edit');
 * ```
 */
export declare function registerGeneralCodingTools(registry: ToolRegistry, deps: GeneralCodingToolDeps): void;
/** Simple in-memory ToolRegistry implementation for testing */
export declare class InMemoryToolRegistry implements ToolRegistry {
    private readonly handlers;
    register(name: string, handler: ToolHandler): void;
    get(name: string): ToolHandler | undefined;
    list(): string[];
}
//# sourceMappingURL=registerGeneralCodingTools.d.ts.map