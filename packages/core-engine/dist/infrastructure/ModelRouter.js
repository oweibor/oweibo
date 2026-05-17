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
 *
 * E.1: forTask() adds bandit-driven tier selection per task category.
 * The existing forSmall/forMid/forLarge methods remain for callers that
 * already know the appropriate tier.
 */
class ModelRouter {
    smallClient;
    midClient;
    largeClient;
    embeddingClient;
    generationClient;
    summarisationClient;
    modelBandit;
    constructor(smallClient, midClient, largeClient, embeddingClient, generationClient, summarisationClient, 
    /** E.1: optional bandit — falls back to static tier map when absent. */
    modelBandit) {
        this.smallClient = smallClient;
        this.midClient = midClient;
        this.largeClient = largeClient;
        this.embeddingClient = embeddingClient;
        this.generationClient = generationClient;
        this.summarisationClient = summarisationClient;
        this.modelBandit = modelBandit;
    }
    forSmall() { return this.smallClient; }
    forMid() { return this.midClient; }
    forLarge() { return this.largeClient; }
    forEmbedding() { return this.embeddingClient; }
    forGeneration() { return this.generationClient; }
    forSummarisation() { return this.summarisationClient; }
    /**
     * E.1 — Bandit-driven tier selection.
     * Resolves to a CompletionClient for the tier the bandit selects for this
     * (taskId, category) pair. Falls back to forMid() when bandit is absent.
     *
     * @param category Task category string ('coding', 'planning', 'analysis', etc.)
     * @param taskId   Used as the sampling seed — ensures same draw on task resume.
     */
    async forTask(taskId, category) {
        if (!this.modelBandit)
            return this.midClient;
        const draw = await this.modelBandit.draw(taskId, category).catch(() => ({ tier: 'mid', modelId: 'default' }));
        return this.tierToClient(draw.tier);
    }
    tierToClient(tier) {
        switch (tier) {
            case 'small': return this.smallClient;
            case 'large': return this.largeClient;
            case 'mid':
            default: return this.midClient;
        }
    }
}
exports.ModelRouter = ModelRouter;
//# sourceMappingURL=ModelRouter.js.map