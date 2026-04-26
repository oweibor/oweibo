/**
 * IDocTemplate — pluggable documentation template contract.
 *
 * Each implementation renders one document category from CodebaseKnowledge.
 * Third-party implementations must pass IDocTemplateContractSuite.
 *
 * Design rules:
 *   - render MUST NOT write to the filesystem — return RenderedDocument only.
 *   - render MUST check AbortSignal between LLM calls.
 *   - render output MUST NOT contain secrets matching DocValidator patterns.
 *   - fileName MUST NOT contain path traversal sequences (../, /).
 */
import type { CodebaseKnowledge } from '../types/CodebaseKnowledge.js';
import type { ILLMClient } from '../types/AgentTypes.js';
import type { ITokenBudget } from './ITokenBudget.js';
export interface DocSection {
    readonly id: string;
    readonly title: string;
    readonly content: string;
    readonly order: number;
    readonly children?: readonly DocSection[];
}
export interface RenderedDocument {
    readonly fileName: string;
    readonly category: DocCategory;
    readonly title: string;
    readonly sections: readonly DocSection[];
    /** Full rendered Markdown content. */
    readonly rendered: string;
}
export type DocCategory = 'architecture' | 'api-reference' | 'developer-guide' | 'module-reference' | 'data-model' | 'event-catalogue' | 'adr' | 'dependency-map' | 'getting-started' | 'glossary' | 'changelog';
export interface DocTemplateContext {
    readonly llm: ILLMClient;
    readonly tokenBudget: ITokenBudget;
}
/** Degradation level per §4.6 graceful degradation matrix. */
export type DegradationLevel = 'full' | 'partial' | 'skeleton' | 'skipped';
export interface ApplicabilityResult {
    readonly applicable: boolean;
    readonly degradationLevel: DegradationLevel;
    /** Human-readable explanation when degraded or skipped. */
    readonly reason?: string;
}
export interface IDocTemplate {
    readonly category: DocCategory;
    /** Base output filename (no directory component). */
    readonly fileName: string;
    /**
     * Determine whether this template can render given the current knowledge.
     * Returns full/partial/skeleton/skipped per §4.6 matrix.
     * Must be synchronous and fast — called before any rendering begins.
     */
    isApplicable(knowledge: CodebaseKnowledge): ApplicabilityResult;
    /**
     * Render the document. May make LLM calls via ctx.tokenBudget.withinBudget().
     * Must respect the AbortSignal by checking signal.throwIfAborted() before each LLM call.
     */
    render(knowledge: CodebaseKnowledge, ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument>;
}
//# sourceMappingURL=IDocTemplate.d.ts.map