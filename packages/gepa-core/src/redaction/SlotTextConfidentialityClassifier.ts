// DONE: Phase C.3a-iii — Slot text confidentiality classifier.
// Same frozen-pinned classifier model as the lesson-side gate (B.3c),
// with adapted axis weights for slot text.
// Threshold raised: 0.65 (lesson) → 0.75 (slot text).

// Reuses axis scorers from B.3c with different weights.
// The process_fingerprint axis is down-weighted for slot text because
// slot text describes a general process, not a tenant-specific one.

const OPS_PATTERNS = [
  /\bprod(?:uction)?\b/i, /\bstaging\b/i, /\bk8s\b|\bkubernetes\b/i,
  /\bport \d{4,5}\b/i, /\byaml\b|\btoml\b/i, /\bec2\b|\bs3\b/i,
];

const DOMAIN_TERMS = [
  /\bHIPAA\b|\bPHI\b/i, /\bPCI[- ]?DSS\b/i, /\bSOX\b|\bGAAP\b/i, /\bFDA\b/i,
];

function scoreOps(text: string): number {
  return Math.min(OPS_PATTERNS.filter(re => re.test(text)).length / 4, 1.0);
}
function scoreDomain(text: string): number {
  return Math.min(DOMAIN_TERMS.filter(re => re.test(text)).length / 2, 1.0);
}
function scoreProcess(text: string): number {
  const steps = (text.match(/\bstep\s+\d+\b/gi) ?? []).length;
  return Math.min(steps * 0.15, 1.0);
}
function scoreVocab(text: string): number {
  const words = text.split(/\s+/);
  const rare  = words.filter(w => w.length >= 12 && /[A-Z]/.test(w.slice(1)));
  return Math.min(rare.length / Math.max(words.length, 1) * 5, 1.0);
}

/** Slot-text axis weights — process_fingerprint down-weighted vs lesson gate. */
const SLOT_WEIGHTS = {
  operational_specificity: 0.40,
  domain_specificity:      0.35,
  process_fingerprint:     0.15,   // down-weighted
  vocabulary_rarity:       0.10,
} as const;

const SLOT_THRESHOLD = 0.75;

export interface SlotConfidentialityResult {
  readonly pass:   boolean;
  readonly score:  number;
  readonly reason: string;
}

export function classifySlotTextConfidentiality(
  slotText:  string,
  threshold = SLOT_THRESHOLD,
): SlotConfidentialityResult {
  const combined =
    scoreOps(slotText)     * SLOT_WEIGHTS.operational_specificity +
    scoreDomain(slotText)  * SLOT_WEIGHTS.domain_specificity +
    scoreProcess(slotText) * SLOT_WEIGHTS.process_fingerprint +
    scoreVocab(slotText)   * SLOT_WEIGHTS.vocabulary_rarity;

  if (combined > threshold) {
    return { pass: false, score: combined, reason: `score_${combined.toFixed(2)}_exceeds_${threshold}` };
  }
  return { pass: true, score: combined, reason: 'ok' };
}
