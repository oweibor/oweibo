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
import type { VaultClient } from './VaultClient.js';
import type { ISecurityContext } from '@oweibo/core-contracts';
export declare class RepoAccessDeniedError extends Error {
    readonly tenantId: string;
    readonly repoPath: string;
    constructor(tenantId: string, repoPath: string, reason: string);
}
/**
 * Asserts that the requesting tenant has `repo:read` permission AND that
 * repoPath is within one of the tenant's configured allowed paths in Vault.
 *
 * @throws RepoAccessDeniedError on any authorization failure.
 */
export declare function assertRepoAccess(vault: VaultClient, tenantId: string, repoPath: string, secCtx: ISecurityContext): Promise<void>;
//# sourceMappingURL=assertRepoAccess.d.ts.map