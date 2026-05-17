import type { FileAnalysis } from '@oweibo/core-contracts';
export type PatternKind = 'repository' | 'service-layer' | 'factory' | 'observer-event-driven' | 'pipeline-middleware' | 'strategy' | 'singleton' | 'dependency-injection' | 'cqrs' | 'monorepo' | 'layered-architecture' | 'hexagonal-architecture';
export interface DetectedPattern {
    readonly kind: PatternKind;
    readonly confidence: number;
    /** File paths that contributed to this detection. */
    readonly evidence: readonly string[];
    readonly description: string;
}
export interface PatternDetectorOptions {
    /** Minimum confidence to include a pattern. Default: 0.7 */
    readonly minConfidence?: number;
}
/**
 * PatternDetector — pure heuristic pattern detection over FileAnalysis results.
 *
 * No LLM calls. Confidence thresholds are empirically tuned per-pattern
 * to balance precision and recall.
 */
export declare class PatternDetector {
    private readonly minConfidence;
    constructor(options?: PatternDetectorOptions);
    detect(files: readonly FileAnalysis[], fsEntries?: readonly string[]): readonly DetectedPattern[];
    private detectMonorepo;
    private detectLayered;
    private detectHexagonal;
    private detectRepository;
    private detectServiceLayer;
    private detectFactory;
    private detectObserver;
    private detectPipeline;
    private detectSingleton;
    private detectDI;
    private detectCqrs;
    private detectStrategy;
}
//# sourceMappingURL=PatternDetector.d.ts.map