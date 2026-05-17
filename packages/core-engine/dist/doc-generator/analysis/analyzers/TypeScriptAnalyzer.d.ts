/**
 * TypeScriptAnalyzer — deep TypeScript/JavaScript code analysis using the TS compiler API.
 *
 * Reuse boundaries (A4, v10.3):
 *   - Reads from CodeIntelligenceLayer ONLY when injected and already indexed.
 *   - Falls back to a standalone ts.createProgram when CIL is absent.
 *   - Writes to DocAnalyzerCache (NOT AstMetadataCache).
 *
 * analyzeDirectory() builds ONE ts.Program per call — 10–50× faster for large repos
 * than per-file createSourceFile.
 */
import type { ILanguageAnalyzer, FileAnalysis, SymbolInfo, EnrichedCallEdge, CodeLanguage } from '@oweibo/core-contracts';
export declare class TypeScriptAnalyzer implements ILanguageAnalyzer {
    readonly supportedLanguages: readonly CodeLanguage[];
    analyzeFile(filePath: string, content: string, signal?: AbortSignal): Promise<FileAnalysis>;
    analyzeDirectory(rootPath: string, filePaths: readonly string[], signal?: AbortSignal): Promise<readonly FileAnalysis[]>;
    extractCallGraph(files: readonly FileAnalysis[], signal?: AbortSignal): Promise<readonly EnrichedCallEdge[]>;
    extractSymbols(files: readonly FileAnalysis[]): readonly SymbolInfo[];
}
//# sourceMappingURL=TypeScriptAnalyzer.d.ts.map