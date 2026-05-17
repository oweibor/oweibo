import type { CodebaseKnowledge } from '@oweibo/core-contracts';
export interface DiagramOptions {
    readonly maxNodes?: number;
}
/**
 * DiagramGenerator — generates Mermaid diagram source strings from CodebaseKnowledge.
 *
 * Mermaid validation: opt-in via --validate-mermaid / options.validateMermaid (B2, v10.4).
 * Default: diagrams are generated as text strings without validation (avoids puppeteer dep).
 */
export declare class DiagramGenerator {
    private readonly options;
    constructor(options?: DiagramOptions);
    /** Generate a flowchart of module dependencies. */
    moduleDependencyGraph(knowledge: CodebaseKnowledge): string;
    /** Generate a simplified call-flow diagram for event edges. */
    eventFlowDiagram(knowledge: CodebaseKnowledge): string;
}
//# sourceMappingURL=DiagramGenerator.d.ts.map