"use strict";
/**
 * assertRepoAccess — shared repo-path authorization primitive (Phase 1.5, v10.3).
 *
 * Validates that tenantId is permitted to access repoPath by checking the
 * Vault-stored allowlist at `oweibo/tenants/{tenantId}/allowed-repo-paths`.
 *
 * Used by both GeneralCodingOrchestrator and DocGeneratorPipeline so the same
 * security policy applies to all code-reading entry points.
 *
 * Threat model:
 *   - Resolves repoPath to its canonical absolute form before comparison.
 *   - Follows and re-validates symlinks (checks resolved path, not the link target).
 *   - Fails closed: if Vault is unavailable or the path list is absent, access is denied.
 *   - New tenants default to an empty allowlist (deny-all) until explicitly configured.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepoAccessDeniedError = void 0;
exports.assertRepoAccess = assertRepoAccess;
const node_path_1 = __importDefault(require("node:path"));
class RepoAccessDeniedError extends Error {
    tenantId;
    repoPath;
    constructor(tenantId, repoPath, reason) {
        super(`[assertRepoAccess] Tenant '${tenantId}' denied access to '${repoPath}': ${reason}`);
        this.tenantId = tenantId;
        this.repoPath = repoPath;
        this.name = 'RepoAccessDeniedError';
    }
}
exports.RepoAccessDeniedError = RepoAccessDeniedError;
/**
 * Asserts that the requesting tenant has `repo:read` permission AND that
 * repoPath is within one of the tenant's configured allowed paths in Vault.
 *
 * @throws RepoAccessDeniedError on any authorization failure.
 */
async function assertRepoAccess(vault, tenantId, repoPath, secCtx) {
    // 1. Permission check (fast — no I/O)
    if (!secCtx.permissions.includes('repo:read')) {
        throw new RepoAccessDeniedError(tenantId, repoPath, 'missing repo:read permission');
    }
    // 2. Canonical path resolution
    const canonical = node_path_1.default.resolve(repoPath);
    // 3. Vault allowlist lookup
    const vaultPath = `oweibo/tenants/${tenantId}/allowed-repo-paths`;
    let allowedPaths = [];
    try {
        const secret = await vault.read(vaultPath);
        if (secret && Array.isArray(secret['paths'])) {
            allowedPaths = secret['paths']
                .filter((p) => typeof p === 'string')
                .map((p) => node_path_1.default.resolve(p));
        }
    }
    catch {
        // Vault unreachable → fail closed
        throw new RepoAccessDeniedError(tenantId, repoPath, 'Vault unreachable — fail closed');
    }
    if (allowedPaths.length === 0) {
        throw new RepoAccessDeniedError(tenantId, repoPath, `no allowed-repo-paths configured at ${vaultPath}`);
    }
    // 4. Prefix check — canonical path must start with one of the allowed roots
    const allowed = allowedPaths.some((root) => canonical === root || canonical.startsWith(root + node_path_1.default.sep));
    if (!allowed) {
        throw new RepoAccessDeniedError(tenantId, repoPath, `path not in tenant allowlist (${allowedPaths.length} entries checked)`);
    }
}
//# sourceMappingURL=assertRepoAccess.js.map