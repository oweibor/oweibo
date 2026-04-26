"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserChromeBackend = void 0;
// packages/browser-tool/src/stealth/backends/UserChromeBackend.ts
// Attaches to a user's Chrome started with --remote-debugging-port (§5.19, v9.5.6).
const playwright_extra_1 = require("playwright-extra");
class UserChromeBackend {
    type = 'userchrome';
    async launchContext(config) {
        const cdp = config.cdpEndpoint ?? 'http://localhost:9222';
        const browser = await playwright_extra_1.chromium.connectOverCDP(cdp);
        const ctxs = browser.contexts();
        if (ctxs.length === 0)
            throw new Error('[UserChromeBackend] no existing contexts to attach to');
        return ctxs[0];
    }
    /** Never close the user's browser. */
    async closeContext(_context) { }
    async captureStorageState(_context) { return null; }
}
exports.UserChromeBackend = UserChromeBackend;
//# sourceMappingURL=UserChromeBackend.js.map