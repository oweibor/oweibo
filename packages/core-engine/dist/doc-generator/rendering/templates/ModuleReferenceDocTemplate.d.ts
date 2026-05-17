import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
/**
 * Generates one docs/modules/<name>.md per module boundary.
 * fileName is the first module's file (multi-render templates override this per-call).
 */
export declare class ModuleReferenceDocTemplate implements IDocTemplate {
    readonly category: "module-reference";
    readonly fileName = "modules/index.md";
    isApplicable(k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=ModuleReferenceDocTemplate.d.ts.map