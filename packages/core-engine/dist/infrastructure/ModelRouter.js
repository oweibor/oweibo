"use strict";
/**
 * ModelRouter — tiered LLM routing (G8).
 *
 * Routes requests to the appropriate model tier based on task complexity:
 *   - small:       file-read / symbol-lookup / governance scans (cheap, fast)
 *   - mid:         diff generation, short completions
 *   - large:       complex refactor planning, multi-file reasoning
 *   - embedding:   vector embeddings for semantic search
 *   - generation:  primary generation model (for tokenizer budget enforcement)
 *   - summarisation: convention extraction, summarisation tasks
 *
 * Each tier returns a typed client with a consistent API so callers do not
 * depend on the concrete model name — model upgrades are a single-line config change.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelRouter = void 0;
/**
 * ModelRouter — injected into all subsystems that need LLM access.
 * Concrete implementation in main.ts wires actual model clients.
 */
class ModelRouter {
    smallClient;
    midClient;
    largeClient;
    embeddingClient;
    generationClient;
    summarisationClient;
    constructor(smallClient, midClient, largeClient, embeddingClient, generationClient, summarisationClient) {
        this.smallClient = smallClient;
        this.midClient = midClient;
        this.largeClient = largeClient;
        this.embeddingClient = embeddingClient;
        this.generationClient = generationClient;
        this.summarisationClient = summarisationClient;
    }
    forSmall() { return this.smallClient; }
    forMid() { return this.midClient; }
    forLarge() { return this.largeClient; }
    forEmbedding() { return this.embeddingClient; }
    forGeneration() { return this.generationClient; }
    forSummarisation() { return this.summarisationClient; }
}
exports.ModelRouter = ModelRouter;
//# sourceMappingURL=ModelRouter.js.map