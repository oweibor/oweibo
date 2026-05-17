import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
export declare class GettingStartedDocTemplate implements IDocTemplate {
    readonly category: "getting-started";
    readonly fileName = "getting-started.md";
    isApplicable(_k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=GettingStartedDocTemplate.d.ts.map