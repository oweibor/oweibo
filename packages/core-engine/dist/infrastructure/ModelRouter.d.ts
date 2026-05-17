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
export interface EmbeddingClient {
    /** Embed a single text string; returns a float array. */
    embed(text: string): Promise<number[]>;
    /** Embedding dimension — used to create Qdrant collections. */
    dimension(): number;
}
export interface CompletionClient {
    /** Single-turn generation. */
    complete(opts: {
        system: string;
        user: string;
        maxTokens?: number;
        temperature?: number;
    }): Promise<string>;
    /** Streaming generation — yields text chunks. */
    stream(opts: {
        systemPrompt: string;
        userPrompt: string;
        temperature?: number;
    }): AsyncIterable<string>;
    /** Returns a tokenizer that encodes/decodes text. */
    tokenizer(): Tokenizer;
}
export interface Tokenizer {
    encode(text: string): number[];
    decode(tokens: number[]): string;
}
import type { ModelBanditService } from './ModelBanditService.js';
/**
 * ModelRouter — injected into all subsystems that need LLM access.
 * Concrete implementation in main.ts wires actual model clients.
 *
 * E.1: forTask() adds bandit-driven tier selection per task category.
 * The existing forSmall/forMid/forLarge methods remain for callers that
 * already know the appropriate tier.
 */
export declare class ModelRouter {
    private readonly smallClient;
    private readonly midClient;
    private readonly largeClient;
    private readonly embeddingClient;
    private readonly generationClient;
    private readonly summarisationClient;
    /** E.1: optional bandit — falls back to static tier map when absent. */
    private readonly modelBandit?;
    constructor(smallClient: CompletionClient, midClient: CompletionClient, largeClient: CompletionClient, embeddingClient: EmbeddingClient, generationClient: CompletionClient, summarisationClient: CompletionClient, 
    /** E.1: optional bandit — falls back to static tier map when absent. */
    modelBandit?: ModelBanditService | undefined);
    forSmall(): CompletionClient;
    forMid(): CompletionClient;
    forLarge(): CompletionClient;
    forEmbedding(): EmbeddingClient;
    forGeneration(): CompletionClient;
    forSummarisation(): CompletionClient;
    /**
     * E.1 — Bandit-driven tier selection.
     * Resolves to a CompletionClient for the tier the bandit selects for this
     * (taskId, category) pair. Falls back to forMid() when bandit is absent.
     *
     * @param category Task category string ('coding', 'planning', 'analysis', etc.)
     * @param taskId   Used as the sampling seed — ensures same draw on task resume.
     */
    forTask(taskId: string, category: string): Promise<CompletionClient>;
    private tierToClient;
}
//# sourceMappingURL=ModelRouter.d.ts.map