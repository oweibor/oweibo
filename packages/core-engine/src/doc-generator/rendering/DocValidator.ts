import type { RenderedDocument, AnalysisWarning } from '@oweibo/core-contracts';

// Secret detection patterns (regex-only; entropy scan is I5 opt-in, B4, v10.4)
const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'stripe-key',   pattern: /sk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'github-pat',   pattern: /ghp_[0-9a-zA-Z]{36}/g },
  { name: 'aws-key',      pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'pem-block',    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'generic-token',pattern: /(?:api_?key|api_?secret|access_?token|secret_?key)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/gi },
];

export interface ValidationResult {
  readonly valid:    boolean;
  readonly warnings: readonly AnalysisWarning[];
}

/**
 * DocValidator — validates rendered documents for secrets and structural issues.
 *
 * SECRET_PATTERNS: regex-only (entropy analysis is Phase I5, B4, v10.4).
 * Validation failures do NOT block export; they produce AnalysisWarning entries
 * so the operator can react via --fail-on=SECRET_DETECTED.
 */
export class DocValidator {
  validate(documents: readonly RenderedDocument[]): ValidationResult {
    const warnings: AnalysisWarning[] = [];

    for (const doc of documents) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        const matches = doc.rendered.match(pattern);
        if (matches) {
          warnings.push({
            code:    'SECRET_DETECTED',
            message: `Potential secret (${name}) detected in ${doc.fileName}`,
            context: { fileName: doc.fileName, pattern: name, count: matches.length },
          });
        }
      }
    }

    return { valid: warnings.length === 0, warnings };
  }

  /** Redact detected secrets from document content (replaces with [REDACTED]). */
  redact(document: RenderedDocument): RenderedDocument {
    let rendered = document.rendered;
    for (const { pattern } of SECRET_PATTERNS) {
      rendered = rendered.replace(pattern, '[REDACTED]');
    }
    return { ...document, rendered };
  }
}
