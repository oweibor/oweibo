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

import path from 'node:path';
import type { VaultClient } from './VaultClient.js';
import type { ISecurityContext } from '@oweibo/core-contracts';

export class RepoAccessDeniedError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly repoPath: string,
    reason: string,
  ) {
    super(`[assertRepoAccess] Tenant '${tenantId}' denied access to '${repoPath}': ${reason}`);
    this.name = 'RepoAccessDeniedError';
  }
}

/**
 * Asserts that the requesting tenant has `repo:read` permission AND that
 * repoPath is within one of the tenant's configured allowed paths in Vault.
 *
 * @throws RepoAccessDeniedError on any authorization failure.
 */
export async function assertRepoAccess(
  vault:    VaultClient,
  tenantId: string,
  repoPath: string,
  secCtx:   ISecurityContext,
): Promise<void> {
  // 1. Permission check (fast — no I/O)
  if (!secCtx.permissions.includes('repo:read')) {
    throw new RepoAccessDeniedError(tenantId, repoPath, 'missing repo:read permission');
  }

  // 2. Canonical path resolution
  const canonical = path.resolve(repoPath);

  // 3. Vault allowlist lookup
  const vaultPath = `oweibo/tenants/${tenantId}/allowed-repo-paths`;
  let allowedPaths: string[] = [];
  try {
    const secret = await vault.read(vaultPath);
    if (secret && Array.isArray(secret['paths'])) {
      allowedPaths = (secret['paths'] as unknown[])
        .filter((p): p is string => typeof p === 'string')
        .map((p) => path.resolve(p));
    }
  } catch {
    // Vault unreachable → fail closed
    throw new RepoAccessDeniedError(tenantId, repoPath, 'Vault unreachable — fail closed');
  }

  if (allowedPaths.length === 0) {
    throw new RepoAccessDeniedError(
      tenantId,
      repoPath,
      `no allowed-repo-paths configured at ${vaultPath}`,
    );
  }

  // 4. Prefix check — canonical path must start with one of the allowed roots
  const allowed = allowedPaths.some(
    (root) => canonical === root || canonical.startsWith(root + path.sep),
  );

  if (!allowed) {
    throw new RepoAccessDeniedError(
      tenantId,
      repoPath,
      `path not in tenant allowlist (${allowedPaths.length} entries checked)`,
    );
  }
}
