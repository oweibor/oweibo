/**
 * CodebaseKnowledge — universal knowledge schema for the autonomous doc-generator.
 *
 * Design notes:
 *   - Intentionally separate from ModuleKnowledge. ModuleKnowledge is tightly
 *     coupled to ArtifactBundle and factory swarm outputs. CodebaseKnowledge
 *     is a superset designed for arbitrary codebases with no factory context.
 *   - A toModuleKnowledge() adapter bridges them for the factory-bridge case.
 *   - All fields are readonly: this type is built once by CodebaseAnalyzer and
 *     consumed read-only by every rendering template.
 */
export type CodeLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'unknown';
export interface FileAnalysis {
    readonly filePath: string;
    readonly language: CodeLanguage;
    readonly lineCount: number;
    /** McCabe cyclomatic complexity. 1 = trivially simple, >10 = review candidate. */
    readonly complexity: number;
    readonly exports: readonly SymbolInfo[];
    readonly imports: readonly ImportInfo[];
    /** External npm package names referenced in this file. */
    readonly dependencies: readonly string[];
}
export interface SymbolInfo {
    readonly name: string;
    readonly kind: 'function' | 'class' | 'interface' | 'variable' | 'type' | 'enum' | 'namespace';
    readonly filePath: string;
    readonly line: number;
    readonly endLine?: number;
    readonly signature?: string;
    readonly rawDocumentation?: string;
    readonly visibility: 'public' | 'private' | 'protected' | 'internal';
    readonly isAsync?: boolean;
    readonly parameters?: readonly ParameterInfo[];
    readonly returnType?: string;
    readonly decorators?: readonly string[];
    /** For classes: the member symbols (methods, properties). */
    readonly members?: readonly SymbolInfo[];
    /** First 6 chars of SHA-256(module root path) — used by CrossRefLinker for disambiguation. */
    readonly moduleHash?: string;
}
export interface ParameterInfo {
    readonly name: string;
    readonly type: string;
    readonly optional: boolean;
    readonly default?: string;
}
export interface ImportInfo {
    readonly source: string;
    readonly symbols: readonly string[];
    readonly isDefault: boolean;
    readonly isNamespace: boolean;
}
export interface ArchitecturalPattern {
    readonly name: string;
    readonly confidence: number;
    readonly evidence: readonly string[];
    readonly description: string;
    readonly category: 'structural' | 'behavioral' | 'creational' | 'integration' | 'infrastructure';
}
export interface ModuleBoundary {
    readonly name: string;
    readonly rootPath: string;
    /** First 6 chars of SHA-256(rootPath) — stable across renames of sub-paths. */
    readonly moduleHash: string;
    readonly entryPoints: readonly string[];
    readonly publicApi: readonly SymbolInfo[];
    readonly internalSymbols: readonly SymbolInfo[];
    readonly dependencies: readonly ModuleDependency[];
    readonly description?: string;
    readonly purposeClass?: 'core' | 'infrastructure' | 'domain' | 'integration' | 'utility';
}
export interface ModuleDependency {
    readonly targetModule: string;
    readonly type: 'import' | 'event' | 'http' | 'shared-state';
    readonly strength: 'strong' | 'weak';
}
export interface EnrichedCallEdge {
    readonly callerFile: string;
    readonly callerSymbol: string;
    readonly calleeFile: string;
    readonly calleeSymbol: string;
    readonly callType: 'direct' | 'async' | 'event-emit' | 'event-subscribe' | 'callback';
    readonly line: number;
}
export interface DataFlowChain {
    readonly name: string;
    readonly description: string;
    readonly steps: readonly DataFlowStep[];
}
export interface DataFlowStep {
    readonly file: string;
    readonly symbol: string;
    readonly action: string;
    readonly dataShape?: string;
}
export interface InferredADR {
    readonly title: string;
    readonly status: 'accepted' | 'inferred';
    readonly context: string;
    readonly decision: string;
    readonly consequences: readonly string[];
    readonly evidence: readonly string[];
    readonly confidence: number;
}
export interface ExternalDependency {
    readonly name: string;
    readonly version: string;
    readonly versionSource: 'lockfile' | 'manifest' | 'unknown';
    readonly purpose?: string;
    readonly isDev: boolean;
    readonly license?: string;
    readonly licenseSource?: 'lockfile' | 'node_modules' | 'unresolved';
}
export interface Convention {
    readonly area: string;
    readonly description: string;
    readonly evidence: readonly string[];
}
export declare const AnalysisWarningCode: {
    readonly PYTHON_NO_AST: "PYTHON_NO_AST";
    readonly PYTHON_SUBPROCESS_CRASH: "PYTHON_SUBPROCESS_CRASH";
    readonly PYTHON_TIMEOUT: "PYTHON_TIMEOUT";
    readonly CIL_UNAVAILABLE: "CIL_UNAVAILABLE";
    readonly FILE_TOO_LARGE: "FILE_TOO_LARGE";
    readonly MAX_FILES_EXCEEDED: "MAX_FILES_EXCEEDED";
    readonly MAX_DEPTH_EXCEEDED: "MAX_DEPTH_EXCEEDED";
    readonly SYMLINK_LOOP: "SYMLINK_LOOP";
    readonly BINARY_FILE_SKIPPED: "BINARY_FILE_SKIPPED";
    readonly LLM_BUDGET_EXHAUSTED: "LLM_BUDGET_EXHAUSTED";
    readonly LLM_TIMEOUT: "LLM_TIMEOUT";
    readonly LLM_RESPONSE_INVALID: "LLM_RESPONSE_INVALID";
    readonly LICENSE_UNRESOLVED: "LICENSE_UNRESOLVED";
    readonly LOCKFILE_NOT_FOUND: "LOCKFILE_NOT_FOUND";
    readonly LOCKFILE_PARSE_ERROR: "LOCKFILE_PARSE_ERROR";
    readonly TEMPLATE_NOT_APPLICABLE: "TEMPLATE_NOT_APPLICABLE";
    readonly TEMPLATE_DEGRADED: "TEMPLATE_DEGRADED";
    readonly CROSS_REF_BROKEN: "CROSS_REF_BROKEN";
    readonly MERMAID_PARSE_ERROR: "MERMAID_PARSE_ERROR";
    readonly SECRET_DETECTED: "SECRET_DETECTED";
    readonly SECRET_ENTROPY_FLAGGED: "SECRET_ENTROPY_FLAGGED";
    readonly COVERAGE_BELOW_THRESHOLD: "COVERAGE_BELOW_THRESHOLD";
    readonly ADR_NAMESPACE_VIOLATION: "ADR_NAMESPACE_VIOLATION";
    readonly OVER_CAP_USAGE: "OVER_CAP_USAGE";
    readonly CACHE_BACKEND_FALLBACK: "CACHE_BACKEND_FALLBACK";
    readonly CACHE_BACKEND_NULL: "CACHE_BACKEND_NULL";
    readonly ZIP_PATH_VIOLATION: "ZIP_PATH_VIOLATION";
    readonly GLOB_PATTERN_INVALID: "GLOB_PATTERN_INVALID";
    readonly WORKER_LOST: "WORKER_LOST";
    readonly SUBPROCESS_POOL_TIMEOUT: "SUBPROCESS_POOL_TIMEOUT";
    readonly QUOTA_EXCEEDED: "QUOTA_EXCEEDED";
    readonly LEGACY_CACHE_ARCHIVED: "LEGACY_CACHE_ARCHIVED";
    readonly CACHE_SCHEMA_MISMATCH: "CACHE_SCHEMA_MISMATCH";
    readonly RUN_CANCELLED: "RUN_CANCELLED";
};
export type AnalysisWarningCode = typeof AnalysisWarningCode[keyof typeof AnalysisWarningCode];
export interface AnalysisWarning {
    readonly code: AnalysisWarningCode;
    readonly message: string;
    readonly context?: Record<string, unknown>;
}
export interface CodebaseKnowledge {
    readonly projectName: string;
    readonly rootPath: string;
    readonly analyzedAt: string;
    readonly analysisDurationMs: number;
    readonly languages: readonly CodeLanguage[];
    readonly totalFiles: number;
    readonly totalLines: number;
    readonly files: readonly FileAnalysis[];
    readonly symbols: readonly SymbolInfo[];
    readonly callGraph: readonly EnrichedCallEdge[];
    readonly modules: readonly ModuleBoundary[];
    readonly patterns: readonly ArchitecturalPattern[];
    readonly dataFlows: readonly DataFlowChain[];
    readonly inferredADRs: readonly InferredADR[];
    readonly externalDependencies: readonly ExternalDependency[];
    readonly internalDependencyGraph: readonly ModuleDependency[];
    readonly projectSummary: string;
    readonly gettingStarted?: string;
    readonly conventions: readonly Convention[];
    readonly warnings: readonly AnalysisWarning[];
}
export interface DryRunReport {
    readonly filesDiscovered: number;
    readonly byLanguage: Partial<Record<CodeLanguage, number>>;
    readonly templatesApplicable: Array<{
        category: string;
        degradationLevel: 'full' | 'partial' | 'skeleton' | 'skipped';
        reason?: string;
    }>;
    readonly requiredCapabilities: Array<{
        capability: 'python' | 'cil' | 'llm' | 'qdrant' | 'lockfile';
        available: boolean;
        impact: string;
    }>;
    readonly estimatedLLMTokens: number;
    readonly estimatedCostUSD?: number;
}
export interface DocsConfig {
    readonly excludePatterns?: readonly string[];
    readonly includePatterns?: readonly string[];
    readonly maxFiles?: number;
    readonly maxFileSize?: number;
    readonly maxDepth?: number;
    readonly skipLLM?: boolean;
    readonly redactAuthors?: boolean;
    readonly strictSecrets?: boolean;
    readonly validateMermaid?: boolean;
    readonly output?: string;
    readonly format?: 'markdown' | 'docusaurus' | 'mintlify' | 'gitbook' | 'single-file';
    readonly only?: readonly string[];
    readonly failOn?: readonly AnalysisWarningCode[];
}
//# sourceMappingURL=CodebaseKnowledge.d.ts.map