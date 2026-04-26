"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalPlaywrightBackend = void 0;
// packages/browser-tool/src/stealth/backends/LocalPlaywrightBackend.ts
// Headless local Chromium via playwright-extra + stealth plugin (§5.1).
const playwright_extra_1 = require("playwright-extra");
const puppeteer_extra_plugin_stealth_1 = __importDefault(require("puppeteer-extra-plugin-stealth"));
playwright_extra_1.chromium.use((0, puppeteer_extra_plugin_stealth_1.default)());
class LocalPlaywrightBackend {
    type = 'local';
    async launchContext(config, profileDir) {
        const launchOpts = {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        };
        if (config.egressProxy)
            launchOpts['proxy'] = config.egressProxy;
        const ctxOpts = {
            locale: config.locale ?? 'en-US',
            timezoneId: config.timezoneId ?? 'America/Los_Angeles',
            viewport: config.viewport ?? { width: 1280, height: 720 },
        };
        if (config.storageState)
            ctxOpts['storageState'] = JSON.parse(config.storageState);
        if (profileDir) {
            return await playwright_extra_1.chromium.launchPersistentContext(profileDir, { ...launchOpts, ...ctxOpts });
        }
        const browser = await playwright_extra_1.chromium.launch(launchOpts);
        return await browser.newContext(ctxOpts);
    }
    async closeContext(context) {
        const ctx = context;
        const browser = ctx.browser();
        await ctx.close();
        if (browser)
            await browser.close().catch(() => { });
    }
    async captureStorageState(context) {
        const state = await context.storageState();
        return JSON.stringify(state);
    }
}
exports.LocalPlaywrightBackend = LocalPlaywrightBackend;
//# sourceMappingURL=LocalPlaywrightBackend.js.map