"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrightDataBackend = void 0;
// packages/browser-tool/src/stealth/backends/BrightDataBackend.ts
// BrightData residential proxy backend (§5.3). Wraps LocalPlaywrightBackend with proxy.
const LocalPlaywrightBackend_js_1 = require("./LocalPlaywrightBackend.js");
class BrightDataBackend {
    proxyHost;
    proxyUser;
    proxyPass;
    type = 'brightdata';
    inner = new LocalPlaywrightBackend_js_1.LocalPlaywrightBackend();
    constructor(proxyHost, proxyUser, proxyPass) {
        this.proxyHost = proxyHost;
        this.proxyUser = proxyUser;
        this.proxyPass = proxyPass;
    }
    async launchContext(config, profileDir) {
        const zone = config.brightDataZone ?? 'datacenter';
        const augmented = {
            ...config,
            egressProxy: {
                server: `http://${this.proxyHost}`,
                username: `${this.proxyUser}-zone-${zone}`,
                password: this.proxyPass,
            },
        };
        return this.inner.launchContext(augmented, profileDir);
    }
    closeContext(context) {
        return this.inner.closeContext(context);
    }
    captureStorageState(context) {
        return this.inner.captureStorageState(context);
    }
}
exports.BrightDataBackend = BrightDataBackend;
//# sourceMappingURL=BrightDataBackend.js.map