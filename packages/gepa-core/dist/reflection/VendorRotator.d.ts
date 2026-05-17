export type Vendor = string;
export interface VendorRotatorConfig {
    /** Ordered vendor panel — rotated per generation index. */
    readonly panel: readonly Vendor[];
}
/**
 * Select the reflection vendor for a given slot and generation.
 * Deterministic: same (slotId, generation) always yields the same vendor.
 */
export declare function selectReflectionVendor(params: {
    slotId: string;
    generation: number;
    panel: readonly Vendor[];
}): Vendor;
export interface EnsembleVetoInput {
    /** Candidate text proposed as a new slot version. */
    readonly candidateText: string;
    /** Slot contract description (what the slot should accomplish). */
    readonly slotContract: string;
    /** Per-vendor agreement score (0-1) — caller provides these after querying each vendor. */
    readonly vendorScores: readonly {
        vendor: Vendor;
        score: number;
    }[];
}
export interface EnsembleVetoResult {
    /** Weighted mean agreement across all vendors. */
    readonly agreement: number;
    /** True if agreement < threshold → candidate should not be promoted. */
    readonly veto: boolean;
    readonly threshold: number;
}
/**
 * Run ensemble veto check.
 * Vetoes the candidate if mean vendor agreement is below threshold.
 */
export declare function runEnsembleVeto(input: EnsembleVetoInput, threshold?: number): EnsembleVetoResult;
/**
 * Check if the frontier shows vendor monoculture.
 * Returns true when >80% of recent offspring used a single vendor.
 */
export declare function detectVendorMonoculture(recentVendors: readonly Vendor[], threshold?: number): {
    monoculture: boolean;
    dominantVendor?: Vendor;
    fraction: number;
};
//# sourceMappingURL=VendorRotator.d.ts.map