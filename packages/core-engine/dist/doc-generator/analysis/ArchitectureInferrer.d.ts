import type { FileAnalysis } from '@oweibo/core-contracts';
import type { ILogger } from './validateGlobPatterns.js';
export type ModulePurpose = 'core' | 'infrastructure' | 'domain' | 'integration' | 'utility' | 'unknown';
export interface ModuleBoundary {
    readonly name: string;
    /** Absolute path to the package root. */
    readonly rootPath: string;
    readonly version: string | undefined;
    /** Whether this package matches a workspace glob (pnpm/lerna). */
    readonly inWorkspace: boolean;
    /** Confidence in this boundary detection. Lower when not in workspace globs. */
    readonly confidence: number;
    /** Public API entry points (barrel index.ts files). */
    readonly entryPoints: readonly string[];
    readonly purpose: ModulePurpose;
    /** LLM-generated description (empty when skipLLM=true). */
    readonly description: string;
    readonly fileCount: number;
    /** Names of other modules this one imports from. */
    readonly dependsOn: readonly string[];
}
export interface ArchitectureInferrerOptions {
    readonly skipLLM?: boolean;
}
/**
 * ArchitectureInferrer — detects monorepo package boundaries and computes
 * inter-module coupling from import graph heuristics.
 *
 * Heuristic phase (always runs):
 *   - Detect package.json boundaries
 *   - Cross-validate against pnpm-workspace.yaml / lerna.json
 *   - Detect barrel index.ts as public API entry points
 *   - Compute coupling via import graph
 *
 * LLM phase (skipped when skipLLM=true):
 *   - 1–2 sentence module description
 *   - Purpose classification
 */
export declare class ArchitectureInferrer {
    private readonly logger;
    private readonly options;
    constructor(logger: ILogger, options?: ArchitectureInferrerOptions);
    infer(rootPath: string, files: readonly FileAnalysis[], signal?: AbortSignal): Promise<readonly ModuleBoundary[]>;
    private findPackageJsons;
    private loadWorkspaceGlobs;
    private buildBoundaries;
    private computeDependsOn;
    private inferPurpose;
    private globMatches;
}
//# sourceMappingURL=ArchitectureInferrer.d.ts.map