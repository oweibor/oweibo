/**
 * SecretsManager — implements ISecretsManager from core-contracts.
 *
 * Routes all secret access through VaultClient, enforcing that secrets are
 * never read directly from environment variables inside agent or pipeline code.
 * Environment variables are only read once at startup (in main.ts) to bootstrap
 * the VaultClient connection itself.
 */
import type { ISecretsManager } from '@oweibo/core-contracts';
import type { VaultClient } from '../infrastructure/VaultClient.js';

export class SecretsManager implements ISecretsManager {
  constructor(private readonly vault: VaultClient) {}

  async getLangfuseCredentials(): Promise<any> { return this.vault.read('langfuse'); }
  async getExportSigningKey(): Promise<any> { return this.vault.read('export-signing-key'); }
  async getDatabaseCredentials(): Promise<any> { return this.vault.read('database'); }
  async getLLMApiKey(provider?: string): Promise<any> { return this.vault.read(`llm/${provider ?? 'default'}`); }
  async getInfraCredentials(name?: string): Promise<any> { return this.vault.read(`infra/${name ?? 'default'}`); }


  async getSecret(path: string): Promise<string> {
    const data = await this.vault.read(path);
    if (!data) throw new Error(`[SecretsManager] Secret not found at path: ${path}`);
    const value = data.value ?? data.token ?? data.secret ?? data.password;
    if (typeof value !== 'string') {
      throw new Error(`[SecretsManager] Expected string secret at ${path}, got ${typeof value}`);
    }
    return value;
  }

  async getSecretOrNull(path: string): Promise<string | null> {
    try {
      return await this.getSecret(path);
    } catch {
      return null;
    }
  }

  async putSecret(path: string, value: string): Promise<void> {
    await this.vault.write(path, { value });
  }
}
