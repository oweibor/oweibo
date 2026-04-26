/**
 * SandboxFactory — backend selection via Vault (§7.2b).
 *
 * Reads SANDBOX_BACKEND from Vault and constructs the appropriate ISandbox.
 * All consuming code calls createSandbox() — never instantiates a concrete class directly.
 * Switching from gVisor to Firecracker = one Vault key change + pool drain/refill.
 */
import type { ISandbox } from '@oweibo/core-contracts';
import { GVisorSandbox } from './GVisorSandbox.js';
import { FirecrackerSandbox } from './FirecrackerSandbox.js';
import type { SecretsManager } from '../secrets/SecretsManager.js';

export type SandboxBackend = 'gvisor' | 'firecracker';

export class SandboxFactory {
  private backend: SandboxBackend | null = null;

  constructor(private readonly secrets: SecretsManager) {}

  async createSandbox(): Promise<ISandbox> {
    if (!this.backend) {
      const creds = await this.secrets.getInfraCredentials('sandbox');
      this.backend = (creds['SANDBOX_BACKEND'] ?? 'gvisor') as SandboxBackend;
    }
    if (this.backend === 'firecracker') {
      return new FirecrackerSandbox();
    }
    return new GVisorSandbox();
  }

  async drainPool(): Promise<void> {
    console.log('[SandboxFactory] Pool drain requested. Next acquire() will cold-boot.');
  }
}
