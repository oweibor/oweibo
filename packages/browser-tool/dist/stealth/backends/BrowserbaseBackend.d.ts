import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
export declare class BrowserbaseBackend implements IBrowserBackend {
    private readonly apiKey;
    readonly type: BrowserBackendType;
    constructor(apiKey: string);
    launchContext(config: BrowserSessionConfig): Promise<unknown>;
    closeContext(context: unknown): Promise<void>;
    captureStorageState(context: unknown): Promise<string | null>;
}
//# sourceMappingURL=BrowserbaseBackend.d.ts.map