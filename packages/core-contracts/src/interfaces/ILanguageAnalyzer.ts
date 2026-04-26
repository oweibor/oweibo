/**
 * ILanguageAnalyzer — pluggable language-specific code analysis.
 *
 * Implementations live in core-engine/doc-generator/analysis/analyzers/.
 * Third-party implementations must pass ILanguageAnalyzerContractSuite.
 *
 * Design rules:
 *   - analyzeFile MUST be pure — no filesystem reads, no LLM calls.
 *   - analyzeDirectory MUST build one AST program per call, not per file.
 *   - AbortSignal must be checked between processing units (per-file at minimum).
 *   - Errors for individual files must be surfaced as AnalysisWarning entries
 *     on the returned FileAnalysis objects, not thrown — partial results beat none.
 */

import type {
  FileAnalysis,
  SymbolInfo,
  EnrichedCallEdge,
  CodeLanguage,
} from '../types/CodebaseKnowledge.js';

export interface ILanguageAnalyzer {
  /** Extensions this analyzer handles (without leading dot, e.g. 'ts'). */
  readonly supportedLanguages: readonly CodeLanguage[];

  /**
   * Analyze a single file.
   * Fast — no LLM calls. Content is passed directly; no filesystem access.
   */
  analyzeFile(
    filePath: string,
    content:  string,
    signal?:  AbortSignal,
  ): Promise<FileAnalysis>;

  /**
   * Batch-analyze all files in a directory.
   * Preferred over N × analyzeFile — enables single-program AST construction.
   * Default implementations may call analyzeFile in a loop.
   */
  analyzeDirectory(
    rootPath:  string,
    filePaths: readonly string[],
    signal?:   AbortSignal,
  ): Promise<readonly FileAnalysis[]>;

  /**
   * Extract inter-file call graph edges from an already-analyzed file set.
   * Pure — operates on in-memory FileAnalysis objects.
   */
  extractCallGraph(
    files:   readonly FileAnalysis[],
    signal?: AbortSignal,
  ): Promise<readonly EnrichedCallEdge[]>;

  /** Extract all exported/public symbols. Synchronous — in-memory only. */
  extractSymbols(files: readonly FileAnalysis[]): readonly SymbolInfo[];
}
