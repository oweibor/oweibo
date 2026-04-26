export interface StorageAdapter {
    put(key: string, data: Buffer, meta?: Record<string, string>): Promise<void>;
    get(key: string): Promise<Buffer | null>;
    delete(key: string): Promise<void>;
    list(prefix: string): Promise<string[]>;
}
export declare class LocalStorageAdapter implements StorageAdapter {
    private readonly basePath;
    constructor(basePath: string);
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer | null>;
    delete(key: string): Promise<void>;
    list(prefix: string): Promise<string[]>;
}
export declare class S3StorageAdapter implements StorageAdapter {
    private readonly client;
    private readonly bucket;
    private readonly commandFactory;
    constructor(client: {
        send(cmd: unknown): Promise<unknown>;
    }, bucket: string, commandFactory: {
        put(bucket: string, key: string, body: Buffer, meta?: Record<string, string>): unknown;
        get(bucket: string, key: string): unknown;
        delete(bucket: string, key: string): unknown;
        list(bucket: string, prefix: string): unknown;
    });
    put(key: string, data: Buffer, meta?: Record<string, string>): Promise<void>;
    get(key: string): Promise<Buffer | null>;
    delete(key: string): Promise<void>;
    list(prefix: string): Promise<string[]>;
}
//# sourceMappingURL=StorageAdapter.d.ts.map