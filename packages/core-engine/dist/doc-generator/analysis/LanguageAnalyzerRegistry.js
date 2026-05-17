"use strict";
/**
 * LanguageAnalyzerRegistry — routes files to the correct ILanguageAnalyzer.
 *
 * Maintains an extension → analyzer map. register() is idempotent.
 * dispatchByExtension() falls back to GenericAnalyzer for unknown extensions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LanguageAnalyzerRegistry = void 0;
class LanguageAnalyzerRegistry {
    byLanguage = new Map();
    fallback = null;
    /** Register an analyzer. If a previous registration exists for the same language, it is replaced. */
    register(analyzer) {
        for (const lang of analyzer.supportedLanguages) {
            this.byLanguage.set(lang, analyzer);
        }
        return this;
    }
    /** Set the fallback analyzer used when no language-specific analyzer is registered. */
    setFallback(analyzer) {
        this.fallback = analyzer;
        return this;
    }
    /** Look up the analyzer for a file extension (without leading dot). */
    dispatchByExtension(ext) {
        const lang = extToLanguage(ext);
        return this.byLanguage.get(lang) ?? this.fallback ?? null;
    }
    /** Look up the analyzer for an explicit language tag. */
    dispatchByLanguage(language) {
        return this.byLanguage.get(language) ?? this.fallback ?? null;
    }
    /**
     * Batch-analyze a set of files, routing each to the appropriate analyzer.
     * Files with no registered analyzer are routed to the fallback.
     * Files with neither an analyzer nor a fallback are skipped with a warning returned.
     */
    async analyzeDirectory(rootPath, filePaths, signal) {
        // Group files by language so each analyzer gets a single analyzeDirectory() call
        const groups = new Map();
        const skipped = [];
        for (const fp of filePaths) {
            const ext = fp.split('.').pop()?.toLowerCase() ?? '';
            const analyzer = this.dispatchByExtension(ext);
            if (!analyzer) {
                skipped.push(fp);
                continue;
            }
            const group = groups.get(analyzer) ?? [];
            group.push(fp);
            groups.set(analyzer, group);
        }
        const allAnalyses = [];
        for (const [analyzer, paths] of groups) {
            signal?.throwIfAborted();
            const results = await analyzer.analyzeDirectory(rootPath, paths, signal);
            allAnalyses.push(...results);
        }
        return { analyses: allAnalyses, skipped };
    }
}
exports.LanguageAnalyzerRegistry = LanguageAnalyzerRegistry;
function extToLanguage(ext) {
    switch (ext.toLowerCase()) {
        case 'ts':
        case 'tsx':
        case 'js':
        case 'jsx':
        case 'mjs':
        case 'cjs': return 'typescript';
        case 'py': return 'python';
        case 'go': return 'go';
        case 'rs': return 'rust';
        case 'java': return 'java';
        default: return 'unknown';
    }
}
//# sourceMappingURL=LanguageAnalyzerRegistry.js.map