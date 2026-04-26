import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
export declare class BrightDataBackend implements IBrowserBackend {
    private readonly proxyHost;
    private readonly proxyUser;
    private readonly proxyPass;
    readonly type: BrowserBackendType;
    private readonly inner;
    constructor(proxyHost: string, proxyUser: string, proxyPass: string);
    launchContext(config: BrowserSessionConfig, profileDir?: string): Promise<unknown>;
    closeContext(context: unknown): Promise<void>;
    captureStorageState(context: unknown): Promise<string | null>;
}
//# sourceMappingURL=BrightDataBackend.d.ts.map