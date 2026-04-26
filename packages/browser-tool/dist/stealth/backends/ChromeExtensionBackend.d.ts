import type { BrowserSessionConfig } from '@oweibo/core-contracts';
import type { IBrowserBackend, BrowserBackendType } from '../../contracts/IBrowserBackend.js';
import type { ExtensionBridgeServer } from '../../session/ExtensionBridgeServer.js';
export interface ExtensionContextProxy {
    readonly _kind: 'extension';
    readonly tenantId: string;
    readonly sessionId: string;
}
export declare class ChromeExtensionBackend implements IBrowserBackend {
    private readonly bridge;
    readonly type: BrowserBackendType;
    constructor(bridge: ExtensionBridgeServer);
    launchContext(config: BrowserSessionConfig): Promise<unknown>;
    closeContext(_context: unknown): Promise<void>;
    captureStorageState(_context: unknown): Promise<string | null>;
}
//# sourceMappingURL=ChromeExtensionBackend.d.ts.map