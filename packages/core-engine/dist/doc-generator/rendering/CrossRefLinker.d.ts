import type { RenderedDocument } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';
/**
 * CrossRefLinker — post-processes rendered Markdown to inject cross-references.
 *
 * Resolves `[[SymbolName]]` wiki-style links to the correct document anchor,
 * using moduleHash for disambiguation when the same symbol name appears in
 * multiple modules.
 */
export declare class CrossRefLinker {
    link(documents: readonly RenderedDocument[], knowledge: CodebaseKnowledge): readonly RenderedDocument[];
    private resolveLinks;
    private findDocForSymbol;
}
//# sourceMappingURL=CrossRefLinker.d.ts.map