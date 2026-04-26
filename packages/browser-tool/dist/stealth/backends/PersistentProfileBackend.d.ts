import type { BrowserSessionConfig, IProfileStore } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
export declare class PersistentProfileBackend implements IBrowserBackend {
    private readonly profileStore;
    readonly type: BrowserBackendType;
    constructor(profileStore: IProfileStore);
    launchContext(config: BrowserSessionConfig): Promise<unknown>;
    closeContext(context: unknown): Promise<void>;
    captureStorageState(_context: unknown): Promise<string | null>;
}
//# sourceMappingURL=PersistentProfileBackend.d.ts.map