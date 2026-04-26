/**
 * ProfileStore — IProfileStore + S3ProfileStore + LocalProfileStore.
 * (NEW v9.5.7)
 *
 * Abstraction over object storage for Chromium user-data-dir archives.
 * Compression: tar + zstd (level 3 default).
 */
import type { IProfileStore } from '@oweibo/core-contracts';
import type { ILogger } from './SessionReaper.js';
interface IS3Client {
    send(cmd: any): Promise<any>;
}
export declare class S3ProfileStore implements IProfileStore {
    private readonly s3;
    private readonly bucket;
    private readonly maxSizeBytes;
    private readonly logger;
    constructor(s3: IS3Client, bucket: string, maxSizeBytes: number, // default 200 MB
    logger: ILogger);
    restore(profileKey: string, targetDir: string): Promise<boolean>;
    snapshot(profileKey: string, sourceDir: string): Promise<{
        sizeBytes: number;
    }>;
    delete(profileKey: string): Promise<void>;
    exists(profileKey: string): Promise<boolean>;
    private s3Key;
    private compress;
    private extractStream;
}
export declare class LocalProfileStore implements IProfileStore {
    private readonly baseDir;
    constructor(baseDir: string);
    private archivePath;
    restore(profileKey: string, targetDir: string): Promise<boolean>;
    snapshot(profileKey: string, sourceDir: string): Promise<{
        sizeBytes: number;
    }>;
    delete(profileKey: string): Promise<void>;
    exists(profileKey: string): Promise<boolean>;
}
export {};
//# sourceMappingURL=ProfileStore.d.ts.map