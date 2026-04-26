"use strict";
/**
 * BrowserExtensionRegistry — Vault-allowlisted extension resolver.
 * (NEW v9.5.5)
 *
 * Resolves a tenant-provided extensionId to an approved server-side directory path.
 * Extensions must be pre-installed on the server, listed in the tenant's Vault key,
 * and reside under the global extensions base directory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserExtensionRegistry = void 0;
const errors_js_1 = require("../contracts/errors.js");
class BrowserExtensionRegistry {
    vault;
    logger;
    loadedBySession = new Map();
    constructor(vault, logger) {
        this.vault = vault;
        this.logger = logger;
    }
    async resolveExtensionPath(extensionId, tenantId, sessionId) {
        const [allowlist, baseDir] = await Promise.all([
            this.vault.read(`oweibo/tenants/${tenantId}/browser/allowed-extensions`),
            this.vault.read('oweibo/infra/browser/extensions-base-dir'),
        ]);
        if (!allowlist?.[extensionId]) {
            throw new errors_js_1.BrowserPolicyViolationError(`Extension "${extensionId}" is not in the tenant's allowed-extensions allowlist.`);
        }
        const serverPath = allowlist[extensionId];
        if (!serverPath.startsWith(baseDir)) {
            throw new errors_js_1.BrowserPolicyViolationError(`Extension path for "${extensionId}" is outside the approved base directory.`);
        }
        const loaded = this.loadedBySession.get(sessionId) ?? [];
        if (!loaded.includes(extensionId)) {
            loaded.push(extensionId);
            this.loadedBySession.set(sessionId, loaded);
        }
        this.logger.info({ extensionId, tenantId, sessionId, serverPath }, 'Extension resolved.');
        return serverPath;
    }
    getLoadedExtensions(sessionId) {
        return this.loadedBySession.get(sessionId) ?? [];
    }
    clearSession(sessionId) {
        this.loadedBySession.delete(sessionId);
    }
}
exports.BrowserExtensionRegistry = BrowserExtensionRegistry;
//# sourceMappingURL=BrowserExtensionRegistry.js.map