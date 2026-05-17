import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
/**
 * ADRDocTemplate — writes to docs/adr-inferred/ ONLY (B5, v10.4).
 * NEVER writes to docs/adr/ (human-authored ADRs are read-only).
 *
 * HIGH-3: renders per-ADR sections so DocExporter writes one file per ADR.
 * HIGH-4: deduplicates against docs/adr/ using TF-cosine ≥ 0.85 or evidence IoU ≥ 0.6.
 */
export declare class ADRDocTemplate implements IDocTemplate {
    readonly category: "adr";
    readonly fileName: "docs/adr-inferred/README.md";
    isApplicable(k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=ADRDocTemplate.d.ts.map