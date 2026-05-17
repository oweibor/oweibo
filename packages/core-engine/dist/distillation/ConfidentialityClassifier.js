"use strict";
// DONE: Phase B.3c — Semantic Confidentiality Classifier (four-axis scorer).
// Classifies whether a lesson text is too specific to a particular tenant's
// operational environment to be safely shared.
//
// The four axes (§5 Tier 1 step 4):
//   operational_specificity — how much it refers to specific ops details
//   domain_specificity      — how much it's tied to a specific domain/industry
//   process_fingerprint     — how much it reveals a proprietary process
//   vocabulary_rarity       — how unusual the vocabulary is (rare = more identifying)
//
// This is a heuristic implementation. Production should pin a frozen classifier
// model version and recalibrate quarterly.
//
// Threshold: combined score > 0.65 → reject (raise to 0.75 for slot-text gate in C).
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyConfidentiality = classifyConfidentiality;
// ── Heuristic axis scorers ────────────────────────────────────────────────────
/** Operational specificity: presence of infra/config/env-specific markers. */
const OPS_MARKERS = [
    /\bprod(?:uction)?\b/i, /\bstaging\b/i, /\bdev(?:elopment)?\b/i,
    /\bk8s\b|\bkubernetes\b/i, /\bdocker\b/i, /\bhelm\b/i,
    /\bvpc\b|\bsubnet\b/i, /\bec2\b|\bs3\b|\brds\b/i,
    /\bport \d{4,5}\b/i, /\bconfig\s*file\b/i, /\byaml\b|\btoml\b/i,
];
function scoreOperationalSpecificity(text) {
    let hits = 0;
    for (const re of OPS_MARKERS)
        if (re.test(text))
            hits++;
    return Math.min(hits / 4, 1.0);
}
/** Domain specificity: presence of industry-specific terminology. */
const DOMAIN_TERMS = [
    /\bHIPAA\b|\bPHI\b|\bEHR\b/i, // healthcare
    /\bPCI[- ]?DSS\b|\bpayment card\b/i, // finance
    /\bSOX\b|\bGAAP\b|\bIFRS\b/i, // accounting
    /\bFDA\b|\bclinical trial\b/i, // pharma
    /\bFedRAMP\b|\bITAR\b|\bCUI\b/i, // govtech
    /\bSLA\b.*\d+%/i, // specific SLA numbers
    /\bERPl?\b|\bSAP\b|\bSalesforce\b/i, // enterprise apps
];
function scoreDomainSpecificity(text) {
    let hits = 0;
    for (const re of DOMAIN_TERMS)
        if (re.test(text))
            hits++;
    return Math.min(hits / 3, 1.0);
}
/** Process fingerprint: reveals a proprietary multi-step process. */
function scoreProcessFingerprint(text) {
    // Multi-step sequences are more fingerprinting
    const stepMatches = (text.match(/\bstep\s+\d+\b|\bphase\s+\d+\b|\b\d+\.\s+[A-Z]/gi) ?? []).length;
    // Specific role/team names
    const roleHits = (text.match(/\b[A-Z][a-z]+Team\b|\bteam\s+[A-Z]\b/g) ?? []).length;
    return Math.min((stepMatches * 0.2 + roleHits * 0.3), 1.0);
}
/** Vocabulary rarity: proportion of rare (≥12-char) compound terms. */
function scoreVocabularyRarity(text) {
    const words = text.split(/\s+/).filter(w => /^[A-Za-z]/.test(w));
    if (words.length === 0)
        return 0;
    const rareWords = words.filter(w => w.length >= 12 && /[A-Z]/.test(w.slice(1)));
    return Math.min(rareWords.length / words.length * 5, 1.0);
}
const AXIS_WEIGHTS = {
    operational_specificity: 0.35,
    domain_specificity: 0.30,
    process_fingerprint: 0.25,
    vocabulary_rarity: 0.10,
};
/**
 * Score and classify a lesson text for confidentiality.
 *
 * @param text      The abstractPattern text to evaluate.
 * @param threshold Combined score above which the text is rejected (default 0.65).
 */
function classifyConfidentiality(text, threshold = 0.65) {
    const ops = scoreOperationalSpecificity(text);
    const dom = scoreDomainSpecificity(text);
    const proc = scoreProcessFingerprint(text);
    const voc = scoreVocabularyRarity(text);
    const combined = ops * AXIS_WEIGHTS.operational_specificity +
        dom * AXIS_WEIGHTS.domain_specificity +
        proc * AXIS_WEIGHTS.process_fingerprint +
        voc * AXIS_WEIGHTS.vocabulary_rarity;
    const score = {
        operational_specificity: ops,
        domain_specificity: dom,
        process_fingerprint: proc,
        vocabulary_rarity: voc,
        combined,
    };
    if (combined > threshold) {
        return {
            pass: false,
            score,
            reason: `combined_score_${combined.toFixed(2)}_exceeds_${threshold}`,
        };
    }
    return { pass: true, score, reason: 'ok' };
}
//# sourceMappingURL=ConfidentialityClassifier.js.map