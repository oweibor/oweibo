import type { RenderedDocument, AnalysisWarning } from '@oweibo/core-contracts';
export interface ValidationResult {
    readonly valid: boolean;
    readonly warnings: readonly AnalysisWarning[];
}
/**
 * DocValidator — validates rendered documents for secrets and structural issues.
 *
 * SECRET_PATTERNS: regex-only (entropy analysis is Phase I5, B4, v10.4).
 * Validation failures do NOT block export; they produce AnalysisWarning entries
 * so the operator can react via --fail-on=SECRET_DETECTED.
 */
export declare class DocValidator {
    validate(documents: readonly RenderedDocument[]): ValidationResult;
    /** Redact detected secrets from document content (replaces with [REDACTED]). */
    redact(document: RenderedDocument): RenderedDocument;
}
//# sourceMappingURL=DocValidator.d.ts.map