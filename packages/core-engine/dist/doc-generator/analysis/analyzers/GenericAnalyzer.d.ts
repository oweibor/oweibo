/**
 * GenericAnalyzer — line-based pattern extraction for unsupported languages.
 *
 * Handles Go, Rust, Java, YAML, JSON, Markdown and any other extension not
 * covered by a dedicated analyzer. Produces best-effort FileAnalysis with:
 *   - File-level metrics (lineCount, basic complexity)
 *   - Top-level declarations via language-specific regex
 *   - No call graph (empty EnrichedCallEdge[])
 */
import type { ILanguageAnalyzer, FileAnalysis, SymbolInfo, EnrichedCallEdge, CodeLanguage } from '@oweibo/core-contracts';
export declare class GenericAnalyzer implements ILanguageAnalyzer {
    readonly supportedLanguages: readonly CodeLanguage[];
    analyzeFile(filePath: string, content: string, signal?: AbortSignal): Promise<FileAnalysis>;
    analyzeDirectory(_rootPath: string, filePaths: readonly string[], signal?: AbortSignal): Promise<readonly FileAnalysis[]>;
    extractCallGraph(_files: readonly FileAnalysis[], signal?: AbortSignal): Promise<readonly EnrichedCallEdge[]>;
    extractSymbols(files: readonly FileAnalysis[]): readonly SymbolInfo[];
}
//# sourceMappingURL=GenericAnalyzer.d.ts.map