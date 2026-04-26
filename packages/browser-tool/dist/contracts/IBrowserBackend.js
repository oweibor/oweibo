"use strict";
/**
 * IBrowserBackend — dependency-inversion interface for browser launch strategies.
 * Implementations: LocalPlaywrightBackend, BrowserbaseBackend, BrightDataBackend,
 *                  UserChromeBackend, PersistentProfileBackend, ChromeExtensionBackend.
 *
 * Note: BrowserContext is typed as `unknown` here to keep core-contracts free of Playwright
 * imports. Each backend's implementation casts appropriately.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=IBrowserBackend.js.map