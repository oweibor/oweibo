/**
 * K.5 — small vector helpers for the fabric semantic layer. Kept local (a
 * 10-line cosine is lower-risk than exporting a module-private from
 * agentic/memory); the Qdrant client, OllamaEmbedder, and EmbeddingCache are
 * the substrate this layer actually REUSES (injected, never forked).
 */

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1] (≈[0,1] for
 * normalized text embeddings). Returns 0 on a zero vector or length mismatch
 * (defensive — a single embedder never mismatches).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
