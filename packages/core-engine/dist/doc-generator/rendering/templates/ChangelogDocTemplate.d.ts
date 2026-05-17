import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
/**
 * ChangelogDocTemplate — Git log with GDPR-compliant author PII redaction (C13, v10.5).
 *
 * When redactAuthors=true (SaaS default): author name and email → '[redacted]'.
 * When redactAuthors=false (self-hosted CLI): author identity preserved.
 */
export declare class ChangelogDocTemplate implements IDocTemplate {
    private readonly redactAuthors;
    private readonly authorMap;
    readonly category: "changelog";
    readonly fileName = "changelog.md";
    constructor(redactAuthors?: boolean, authorMap?: Map<string, string>);
    isApplicable(k: CodebaseKnowledge): ApplicabilityResult;
    render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
    private resolveAuthor;
    private gitLog;
}
//# sourceMappingURL=ChangelogDocTemplate.d.ts.map