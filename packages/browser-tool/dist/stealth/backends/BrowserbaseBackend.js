"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserbaseBackend = void 0;
// packages/browser-tool/src/stealth/backends/BrowserbaseBackend.ts
// Browserbase remote browser backend (§5.2). Connect via CDP using Browserbase session URL.
const playwright_extra_1 = require("playwright-extra");
class BrowserbaseBackend {
    apiKey;
    type = 'browserbase';
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    async launchContext(config) {
        const projectId = config.browserbaseProjectId;
        if (!projectId)
            throw new Error('[BrowserbaseBackend] browserbaseProjectId required');
        const res = await fetch('https://api.browserbase.com/v1/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': this.apiKey },
            body: JSON.stringify({ projectId }),
        });
        if (!res.ok)
            throw new Error(`[BrowserbaseBackend] HTTP ${res.status}`);
        const session = await res.json();
        const browser = await playwright_extra_1.chromium.connectOverCDP(session.connectUrl);
        const contexts = browser.contexts();
        return contexts[0] ?? await browser.newContext();
    }
    async closeContext(context) {
        const ctx = context;
        const browser = ctx.browser();
        if (browser)
            await browser.close().catch(() => { });
    }
    async captureStorageState(context) {
        return JSON.stringify(await context.storageState());
    }
}
exports.BrowserbaseBackend = BrowserbaseBackend;
//# sourceMappingURL=BrowserbaseBackend.js.map