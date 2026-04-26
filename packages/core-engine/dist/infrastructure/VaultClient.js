"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullVaultClient = void 0;
/**
 * NullVaultClient — no-op implementation for local development and testing.
 * All reads return null; writes are discarded silently.
 */
class NullVaultClient {
    async read(_path) {
        return null;
    }
    async write(_path, _data) {
        // no-op
    }
}
exports.NullVaultClient = NullVaultClient;
//# sourceMappingURL=VaultClient.js.map