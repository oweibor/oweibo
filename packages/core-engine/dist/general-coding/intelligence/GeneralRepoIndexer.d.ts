type QdrantClient = any;
import type { ILLMClient } from '@oweibo/core-contracts';
/**
 * GeneralRepoIndexer — indexes an arbitrary repo into a tenant-scoped Qdrant collection.
 *
 * Collection naming: `general-repo:{tenantId}:{sessionId}`
 * Ensures two tenants can never share a collection, even with the same sessionId.
 *
 * Chunking: TypeScript/JS files are chunked by function/class body (delimiter-based).
 * Other files use fixed 100-line chunks with 10-line overlap.
 *
 * v9.1: Batched embeddings (20 per round) to reduce Qdrant round-trips.
 */
export declare class GeneralRepoIndexer {
    private readonly qdrant;
    private readonly llm;
    private static readonly VECTOR_SIZE;
    private static readonly CHUNK_OVERLAP_LINES;
    constructor(qdrant: QdrantClient, llm: ILLMClient);
    index(repoRoot: string, collectionName: string, tenantId: string): Promise<void>;
    reindexFiles(collectionName: string, filePaths: string[]): Promise<void>;
    /**
     * v9.1: Batched reindex — processes files sequentially to avoid memory pressure.
     */
    reindexFilesBatched(collectionName: string, filePaths: string[]): Promise<void>;
    search(collectionName: string, query: string, topK?: number): Promise<string>;
    cleanupSession(collectionName: string): Promise<void>;
    private walkRepo;
    private chunkFile;
    private upsertChunks;
    private readFileContent;
    private embed;
    private hashId;
}
export {};
//# sourceMappingURL=GeneralRepoIndexer.d.ts.map