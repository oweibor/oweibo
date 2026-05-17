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
export declare class OllamaEmbedder {
    private readonly opts;
    constructor(opts: OllamaEmbedderOptions);
    embed(text: string): Promise<number[]>;
    dimension(): number;
    /** Adapt to the QdrantSemanticStore `Embedder` function signature. */
    asEmbedder(): Embedder;
}
//# sourceMappingURL=OllamaEmbedder.d.ts.map