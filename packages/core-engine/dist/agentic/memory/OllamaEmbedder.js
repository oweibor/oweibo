"use strict";
/**
 * OllamaEmbedder — minimal HTTP adapter to a local Ollama server's
 * /api/embeddings endpoint, conforming to the QdrantSemanticStore Embedder
 * type and the ModelRouter EmbeddingClient interface.
 *
 * Uses fetch directly to keep the package free of an Ollama SDK dependency
 * — the API surface is stable enough that one-line POST is reliable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaEmbedder = void 0;
class OllamaEmbedder {
    opts;
    constructor(opts) {
        this.opts = {
            dimension: 768,
            timeoutMs: 15_000,
            ...opts,
        };
    }
    async embed(text) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
        try {
            const r = await fetch(`${this.opts.baseUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.opts.model, prompt: text }),
                signal: ctrl.signal,
            });
            if (!r.ok) {
                throw new Error(`OllamaEmbedder: HTTP ${r.status} from ${this.opts.baseUrl}`);
            }
            const data = await r.json();
            if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
                throw new Error('OllamaEmbedder: response missing or empty `embedding`');
            }
            return data.embedding;
        }
        finally {
            clearTimeout(timer);
        }
    }
    dimension() {
        return this.opts.dimension;
    }
    /** Adapt to the QdrantSemanticStore `Embedder` function signature. */
    asEmbedder() {
        return (text) => this.embed(text);
    }
}
exports.OllamaEmbedder = OllamaEmbedder;
//# sourceMappingURL=OllamaEmbedder.js.map