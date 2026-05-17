/**
 * LanguageAnalyzerRegistry — routes files to the correct ILanguageAnalyzer.
 *
 * Maintains an extension → analyzer map. register() is idempotent.
 * dispatchByExtension() falls back to GenericAnalyzer for unknown extensions.
 */
import type { ILanguageAnalyzer } from '@oweibo/core-contracts';
import type { CodeLanguage } from '@oweibo/core-contracts';
export declare class LanguageAnalyzerRegistry {
    private readonly byLanguage;
    private fallback;
    /** Register an analyzer. If a previous registration exists for the same language, it is replaced. */
    register(analyzer: ILanguageAnalyzer): this;
    /** Set the fallback analyzer used when no language-specific analyzer is registered. */
    setFallback(analyzer: ILanguageAnalyzer): this;
    /** Look up the analyzer for a file extension (without leading dot). */
    dispatchByExtension(ext: string): ILanguageAnalyzer | null;
    /** Look up the analyzer for an explicit language tag. */
    dispatchByLanguage(language: CodeLanguage): ILanguageAnalyzer | null;
    /**
     * Batch-analyze a set of files, routing each to the appropriate analyzer.
     * Files with no registered analyzer are routed to the fallback.
     * Files with neither an analyzer nor a fallback are skipped with a warning returned.
     */
    analyzeDirectory(rootPath: string, filePaths: readonly string[], signal?: AbortSignal): Promise<{
        analyses: Awaited<ReturnType<ILanguageAnalyzer['analyzeDirectory']>>;
        skipped: string[];
    }>;
}
//# sourceMappingURL=LanguageAnalyzerRegistry.d.ts.map