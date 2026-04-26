"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistentProfileBackend = void 0;
// packages/browser-tool/src/stealth/backends/PersistentProfileBackend.ts
// Persistent on-disk Chromium profile (§5.20, v9.5.7) — survives restarts, supports
// human-trained sessions and long-running cookie state.
const playwright_extra_1 = require("playwright-extra");
class PersistentProfileBackend {
    profileStore;
    type = 'persistent';
    constructor(profileStore) {
        this.profileStore = profileStore;
    }
    async launchContext(config) {
        const profileKey = config.persistentProfileId;
        if (!profileKey)
            throw new Error('[PersistentProfileBackend] persistentProfileId required');
        const profileDir = await this.profileStore
            .acquireProfileDir(config.tenantId, profileKey);
        return await playwright_extra_1.chromium.launchPersistentContext(profileDir, {
            headless: false,
            viewport: config.viewport ?? { width: 1280, height: 720 },
            locale: config.locale ?? 'en-US',
            args: ['--disable-blink-features=AutomationControlled'],
        });
    }
    async closeContext(context) {
        await context.close().catch(() => { });
    }
    async captureStorageState(_context) {
        // Profile is the source of truth — no need for explicit storageState capture.
        return null;
    }
}
exports.PersistentProfileBackend = PersistentProfileBackend;
//# sourceMappingURL=PersistentProfileBackend.js.map