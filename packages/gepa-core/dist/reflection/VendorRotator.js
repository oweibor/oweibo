// DONE: Phase C.3a-ii — VendorRotator.
// Round-robin reflection vendor selection per (slotId, generation).
// Ensemble veto for promotion candidates.
/**
 * Select the reflection vendor for a given slot and generation.
 * Deterministic: same (slotId, generation) always yields the same vendor.
 */
export function selectReflectionVendor(params) {
    if (params.panel.length === 0)
        throw new Error('Vendor panel must not be empty');
    // Hash slotId to a stable offset, then rotate by generation
    const slotOffset = hashSlotId(params.slotId);
    const idx = (slotOffset + params.generation) % params.panel.length;
    return params.panel[idx];
}
function hashSlotId(slotId) {
    let h = 0;
    for (let i = 0; i < slotId.length; i++) {
        h = (h * 31 + slotId.charCodeAt(i)) >>> 0;
    }
    return h;
}
/** Minimum multi-vendor agreement required to promote a candidate. */
const DEFAULT_VETO_THRESHOLD = 0.60;
/**
 * Run ensemble veto check.
 * Vetoes the candidate if mean vendor agreement is below threshold.
 */
export function runEnsembleVeto(input, threshold = DEFAULT_VETO_THRESHOLD) {
    if (input.vendorScores.length === 0) {
        return { agreement: 0, veto: true, threshold };
    }
    const mean = input.vendorScores.reduce((s, v) => s + v.score, 0) / input.vendorScores.length;
    return { agreement: mean, veto: mean < threshold, threshold };
}
/**
 * Check if the frontier shows vendor monoculture.
 * Returns true when >80% of recent offspring used a single vendor.
 */
export function detectVendorMonoculture(recentVendors, threshold = 0.80) {
    if (recentVendors.length === 0)
        return { monoculture: false, fraction: 0 };
    const counts = {};
    for (const v of recentVendors)
        counts[v] = (counts[v] ?? 0) + 1;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [top] = entries;
    if (!top)
        return { monoculture: false, fraction: 0 };
    const fraction = top[1] / recentVendors.length;
    return { monoculture: fraction >= threshold, dominantVendor: top[0], fraction };
}
//# sourceMappingURL=VendorRotator.js.map