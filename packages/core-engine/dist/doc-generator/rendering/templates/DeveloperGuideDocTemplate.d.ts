import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
export declare class DeveloperGuideDocTemplate implements IDocTemplate {
    readonly category: "developer-guide";
    readonly fileName = "developer-guide.md";
    isApplicable(_k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=DeveloperGuideDocTemplate.d.ts.map