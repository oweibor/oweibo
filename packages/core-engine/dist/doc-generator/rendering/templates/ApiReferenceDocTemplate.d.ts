import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
export declare class ApiReferenceDocTemplate implements IDocTemplate {
    readonly category: "api-reference";
    readonly fileName = "api-reference.md";
    isApplicable(k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=ApiReferenceDocTemplate.d.ts.map