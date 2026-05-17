/**
 * PythonAnalyzer — Python AST extraction via subprocess + regex fallback.
 *
 * Two-tier strategy (A1, v10.3):
 *   1. Preferred: Python ast subprocess (python3/python -u -). Accurate per-file
 *      syntactic analysis. Long-lived subprocess pool (C15, v10.5).
 *   2. Fallback: regex when Python unavailable or subprocess crash exhausted retries.
 *
 * Honest scope (A1, v10.3):
 *   - Single-file syntactic analysis only. No cross-module type resolution.
 *   - Cross-file call edges produced via import-resolution heuristic (not type inference).
 *   - PYTHON_NO_AST warning emitted when falling back to regex.
 */
import type { ILanguageAnalyzer, FileAnalysis, SymbolInfo, EnrichedCallEdge, CodeLanguage } from '@oweibo/core-contracts';
export declare class PythonAnalyzer implements ILanguageAnalyzer {
    readonly supportedLanguages: readonly CodeLanguage[];
    private readonly pool;
    analyzeFile(filePath: string, content: string, signal?: AbortSignal): Promise<FileAnalysis>;
    analyzeDirectory(_rootPath: string, filePaths: readonly string[], signal?: AbortSignal): Promise<readonly FileAnalysis[]>;
    extractCallGraph(files: readonly FileAnalysis[], signal?: AbortSignal): Promise<readonly EnrichedCallEdge[]>;
    extractSymbols(files: readonly FileAnalysis[]): readonly SymbolInfo[];
    /** Shut down all pooled subprocesses (call on pod SIGTERM). */
    shutdown(): void;
}
//# sourceMappingURL=PythonAnalyzer.d.ts.map