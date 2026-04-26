"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChromeExtensionBackend = void 0;
class ChromeExtensionBackend {
    bridge;
    type = 'extension';
    constructor(bridge) {
        this.bridge = bridge;
    }
    async launchContext(config) {
        // Bridge must already have a paired extension client for this tenant.
        const ok = await this.bridge.hasClient(config.tenantId);
        if (!ok)
            throw new Error('[ChromeExtensionBackend] no paired extension client for tenant');
        const proxy = {
            _kind: 'extension',
            tenantId: config.tenantId,
            sessionId: config.sessionId,
        };
        return proxy;
    }
    async closeContext(_context) { }
    async captureStorageState(_context) { return null; }
}
exports.ChromeExtensionBackend = ChromeExtensionBackend;
//# sourceMappingURL=ChromeExtensionBackend.js.map