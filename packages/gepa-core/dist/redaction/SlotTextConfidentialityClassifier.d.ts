export interface SlotConfidentialityResult {
    readonly pass: boolean;
    readonly score: number;
    readonly reason: string;
}
export declare function classifySlotTextConfidentiality(slotText: string, threshold?: number): SlotConfidentialityResult;
//# sourceMappingURL=SlotTextConfidentialityClassifier.d.ts.map