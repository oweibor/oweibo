// DONE: Phase C.3a-iv — RegurgitationDetector.
// Detects when a reflection LLM mutation verbatim-copies from the lesson sample
// it was shown. Uses cosine similarity over word-frequency vectors (fast, no LLM).
// Exit criterion: ≥9/10 synthetic verbatim-copy cases rejected; FP rate <5%.

/** Minimum similarity threshold to flag as regurgitation (default 0.85). */
export const DEFAULT_REGURGITATION_THRESHOLD = 0.85;

/** Convert text to a word-frequency map (bag-of-words). */
function wordFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  for (const w of words) {
    if (w.length < 3) continue; // skip stopwords
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return freq;
}

/** Cosine similarity between two word-frequency maps. */
function cosineSimilarityBOW(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [word, countA] of a) {
    const countB = b.get(word) ?? 0;
    dot += countA * countB;
    na  += countA * countA;
  }
  for (const [, countB] of b) nb += countB * countB;
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Compute the maximum similarity between a mutation candidate and any lesson
 * in the lesson sample. Lesson embeddings can be pre-computed and passed in
 * as BOW maps for efficiency.
 *
 * @param mutationText    The proposed slot mutation text.
 * @param recentLessons   The ~20 lessons the reflection LLM was shown.
 * @returns               Maximum cosine similarity (0-1).
 */
export function maxSimilarity(
  mutationText:  string,
  recentLessons: readonly string[],
): number {
  if (recentLessons.length === 0) return 0;
  const mutationBOW = wordFrequency(mutationText);
  let max = 0;
  for (const lesson of recentLessons) {
    const sim = cosineSimilarityBOW(mutationBOW, wordFrequency(lesson));
    if (sim > max) max = sim;
  }
  return max;
}

export interface RegurgitationResult {
  readonly regurgitated: boolean;
  readonly maxSim:       number;
  readonly threshold:    number;
}

/**
 * Classify whether a mutation text is a regurgitation of a lesson.
 */
export function detectRegurgitation(
  mutationText:  string,
  recentLessons: readonly string[],
  threshold = DEFAULT_REGURGITATION_THRESHOLD,
): RegurgitationResult {
  const sim = maxSimilarity(mutationText, recentLessons);
  return { regurgitated: sim >= threshold, maxSim: sim, threshold };
}
