/**
 * BrowserExtensionRegistry — Vault-allowlisted extension resolver.
 * (NEW v9.5.5)
 *
 * Resolves a tenant-provided extensionId to an approved server-side directory path.
 * Extensions must be pre-installed on the server, listed in the tenant's Vault key,
 * and reside under the global extensions base directory.
 */
import type { ILogger } from './SessionReaper.js';
interface IVaultClient {
    read(path: string): Promise<unknown>;
}
export declare class BrowserExtensionRegistry {
    private readonly vault;
    private readonly logger;
    private readonly loadedBySession;
    constructor(vault: IVaultClient, logger: ILogger);
    resolveExtensionPath(extensionId: string, tenantId: string, sessionId: string): Promise<string>;
    getLoadedExtensions(sessionId: string): string[];
    clearSession(sessionId: string): void;
}
export {};
//# sourceMappingURL=BrowserExtensionRegistry.d.ts.map