import type { IToolDefinition, IToolInvocationResult, ISecurityContext } from '@oweibo/core-contracts';
type QdrantClient = {
    upsert(collection: string, args: {
        points: unknown[];
    }): Promise<unknown>;
    search(collection: string, args: {
        vector: number[];
        limit: number;
        with_payload?: boolean;
    }): Promise<Array<{
        payload?: unknown;
    }>>;
    getCollections(): Promise<{
        collections: Array<{
            name: string;
        }>;
    }>;
    createCollection(name: string, args: unknown): Promise<unknown>;
};
export declare class PermissionDeniedError extends Error {
    constructor(toolName: string, required: readonly string[], provided: readonly string[]);
}
export declare class SchemaValidationError extends Error {
    constructor(toolName: string, direction: 'input' | 'output', detail: string);
}
export interface ExtendedToolDefinition extends IToolDefinition {
    outputSchema?: unknown;
    allowHotReload?: boolean;
    securityContext?: {
        permissions: readonly string[];
    };
    handler?: (input: unknown) => Promise<unknown>;
}
export declare class ToolRegistry {
    private readonly qdrant;
    private readonly embedFn?;
    private tools;
    private readonly COLLECTION;
    constructor(qdrant: QdrantClient, embedFn?: ((text: string) => Promise<number[]>) | undefined);
    register(tool: ExtendedToolDefinition): Promise<void>;
    semanticSearch(query: string, topK?: number): Promise<readonly IToolDefinition[]>;
    invoke(name: string, input: unknown, securityContext: ISecurityContext): Promise<IToolInvocationResult>;
    list(): readonly IToolDefinition[];
    private nameToId;
    private embed;
}
export {};
//# sourceMappingURL=ToolRegistry.d.ts.map