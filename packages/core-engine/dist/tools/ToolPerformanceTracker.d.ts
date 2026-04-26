type QdrantClient = {
    upsert(collection: string, args: {
        points: unknown[];
    }): Promise<unknown>;
    search(collection: string, args: {
        vector: number[];
        limit: number;
        with_payload?: boolean;
        filter?: unknown;
    }): Promise<Array<{
        payload?: unknown;
    }>>;
};
export interface ToolPerformanceRecord {
    toolName: string;
    taskContext: string;
    success: boolean;
    durationMs: number;
    errorCode?: string;
    timestamp: number;
}
export declare class ToolPerformanceTracker {
    private readonly qdrant;
    private readonly embedFn;
    private readonly COLLECTION;
    constructor(qdrant: QdrantClient, embedFn: (text: string) => Promise<number[]>);
    record(rec: ToolPerformanceRecord): Promise<void>;
    rankForContext(query: string, candidates: string[], topK?: number): Promise<string[]>;
}
export {};
//# sourceMappingURL=ToolPerformanceTracker.d.ts.map