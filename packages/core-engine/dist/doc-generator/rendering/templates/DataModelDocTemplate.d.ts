import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
export declare class DataModelDocTemplate implements IDocTemplate {
    readonly category: "data-model";
    readonly fileName = "data-model.md";
    isApplicable(k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=DataModelDocTemplate.d.ts.map