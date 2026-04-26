import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
export declare class UserChromeBackend implements IBrowserBackend {
    readonly type: BrowserBackendType;
    launchContext(config: BrowserSessionConfig): Promise<unknown>;
    /** Never close the user's browser. */
    closeContext(_context: unknown): Promise<void>;
    captureStorageState(_context: unknown): Promise<string | null>;
}
//# sourceMappingURL=UserChromeBackend.d.ts.map