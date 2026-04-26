/**
 * IBrowserBackend — dependency-inversion interface for browser launch strategies.
 * Implementations: LocalPlaywrightBackend, BrowserbaseBackend, BrightDataBackend,
 *                  UserChromeBackend, PersistentProfileBackend, ChromeExtensionBackend.
 *
 * Note: BrowserContext is typed as `unknown` here to keep core-contracts free of Playwright
 * imports. Each backend's implementation casts appropriately.
 */
import type { BrowserSessionConfig } from '@oweibo/core-contracts';
export type BrowserBackendType = 'local' | 'browserbase' | 'brightdata' | 'userchrome' | 'persistent' | 'extension';
export interface IBrowserBackend {
    readonly type: BrowserBackendType;
    /**
     * Launch (or attach to) a browser context for the given session config.
     * Returns a Playwright BrowserContext (or equivalent proxy for extension backend).
     */
    launchContext(config: BrowserSessionConfig, profileDir?: string): Promise<unknown>;
    /**
     * Gracefully close the context. Implementations must NOT close the user's
     * browser for userchrome and extension backends.
     */
    closeContext(context: unknown): Promise<void>;
    /**
     * Capture a storageState JSON string for session snapshot/restore.
     * Returns null for backends that manage their own state (userchrome, extension, persistent).
     */
    captureStorageState(context: unknown): Promise<string | null>;
}
//# sourceMappingURL=IBrowserBackend.d.ts.map