/**
 * OllamaEmbedder — minimal HTTP adapter to a local Ollama server's
 * /api/embeddings endpoint, conforming to the QdrantSemanticStore Embedder
 * type and the ModelRouter EmbeddingClient interface.
 *
 * Uses fetch directly to keep the package free of an Ollama SDK dependency
 * — the API surface is stable enough that one-line POST is reliable.
 */

import type { Embedder } from './QdrantSemanticStore.js';

export interface OllamaEmbedderOptions {
  /** Base URL of the Ollama server (no trailing slash). */
  readonly baseUrl: string;
  /** Embedding model name, e.g. `nomic-embed-text` or `mxbai-embed-large`. */
  readonly model: string;
  /**
   * Embedding vector dimension produced by the model. Used by callers that
   * auto-create Qdrant collections. Default 768 (nomic-embed-text).
   */
  readonly dimension?: number;
  /** Per-request timeout in ms. Default 15s. */
  readonly timeoutMs?: number;
}

interface OllamaEmbedResponse {
  readonly embedding?: number[];
}

export class OllamaEmbedder {
  private readonly opts: Required<OllamaEmbedderOptions>;

  constructor(opts: OllamaEmbedderOptions) {
    this.opts = {
      dimension: 768,
      timeoutMs: 15_000,
      ...opts,
    };
  }

  async embed(text: string): Promise<number[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const r = await fetch(`${this.opts.baseUrl}/api/embeddings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: this.opts.model, prompt: text }),
        signal:  ctrl.signal,
      });
      if (!r.ok) {
        throw new Error(`OllamaEmbedder: HTTP ${r.status} from ${this.opts.baseUrl}`);
      }
      const data = await r.json() as OllamaEmbedResponse;
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new Error('OllamaEmbedder: response missing or empty `embedding`');
      }
      return data.embedding;
    } finally {
      clearTimeout(timer);
    }
  }

  dimension(): number {
    return this.opts.dimension;
  }

  /** Adapt to the QdrantSemanticStore `Embedder` function signature. */
  asEmbedder(): Embedder {
    return (text: string) => this.embed(text);
  }
}
