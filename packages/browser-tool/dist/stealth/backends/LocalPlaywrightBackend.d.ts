import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
export declare class LocalPlaywrightBackend implements IBrowserBackend {
    readonly type: BrowserBackendType;
    launchContext(config: BrowserSessionConfig, profileDir?: string): Promise<unknown>;
    closeContext(context: unknown): Promise<void>;
    captureStorageState(context: unknown): Promise<string | null>;
}
//# sourceMappingURL=LocalPlaywrightBackend.d.ts.map