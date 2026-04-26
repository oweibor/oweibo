/**
 * BrowserExtensionRegistry — Vault-allowlisted extension resolver.
 * (NEW v9.5.5)
 *
 * Resolves a tenant-provided extensionId to an approved server-side directory path.
 * Extensions must be pre-installed on the server, listed in the tenant's Vault key,
 * and reside under the global extensions base directory.
 */

import type { ILogger } from './SessionReaper.js';
import { BrowserPolicyViolationError } from '../contracts/errors.js';

interface IVaultClient {
  read(path: string): Promise<unknown>;
}

export class BrowserExtensionRegistry {
  private readonly loadedBySession = new Map<string, string[]>();

  constructor(
    private readonly vault: IVaultClient,
    private readonly logger: ILogger,
  ) {}

  async resolveExtensionPath(
    extensionId: string,
    tenantId: string,
    sessionId: string,
  ): Promise<string> {
    const [allowlist, baseDir] = await Promise.all([
      this.vault.read(
        `oweibo/tenants/${tenantId}/browser/allowed-extensions`,
      ) as Promise<Record<string, string> | null>,
      this.vault.read('oweibo/infra/browser/extensions-base-dir') as Promise<string>,
    ]);

    if (!allowlist?.[extensionId]) {
      throw new BrowserPolicyViolationError(
        `Extension "${extensionId}" is not in the tenant's allowed-extensions allowlist.`,
      );
    }

    const serverPath = allowlist[extensionId];
    if (!serverPath.startsWith(baseDir)) {
      throw new BrowserPolicyViolationError(
        `Extension path for "${extensionId}" is outside the approved base directory.`,
      );
    }

    const loaded = this.loadedBySession.get(sessionId) ?? [];
    if (!loaded.includes(extensionId)) {
      loaded.push(extensionId);
      this.loadedBySession.set(sessionId, loaded);
    }

    this.logger.info(
      { extensionId, tenantId, sessionId, serverPath },
      'Extension resolved.',
    );

    return serverPath;
  }

  getLoadedExtensions(sessionId: string): string[] {
    return this.loadedBySession.get(sessionId) ?? [];
  }

  clearSession(sessionId: string): void {
    this.loadedBySession.delete(sessionId);
  }
}
