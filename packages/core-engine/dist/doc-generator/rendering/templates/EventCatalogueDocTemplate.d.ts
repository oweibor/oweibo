import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
export declare class EventCatalogueDocTemplate implements IDocTemplate {
    readonly category: "event-catalogue";
    readonly fileName = "event-catalogue.md";
    isApplicable(k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=EventCatalogueDocTemplate.d.ts.map