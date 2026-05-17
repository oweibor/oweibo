export interface ConfidentialityScore {
    readonly operational_specificity: number;
    readonly domain_specificity: number;
    readonly process_fingerprint: number;
    readonly vocabulary_rarity: number;
    readonly combined: number;
}
export interface ConfidentialityResult {
    readonly pass: boolean;
    readonly score: ConfidentialityScore;
    readonly reason: string;
}
/**
 * Score and classify a lesson text for confidentiality.
 *
 * @param text      The abstractPattern text to evaluate.
 * @param threshold Combined score above which the text is rejected (default 0.65).
 */
export declare function classifyConfidentiality(text: string, threshold?: number): ConfidentialityResult;
//# sourceMappingURL=ConfidentialityClassifier.d.ts.map