"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=ILanguageAnalyzer.js.map