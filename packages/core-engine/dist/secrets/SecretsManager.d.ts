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
export declare class SecretsManager implements ISecretsManager {
    private readonly vault;
    constructor(vault: VaultClient);
    getLangfuseCredentials(): Promise<any>;
    getExportSigningKey(): Promise<any>;
    getDatabaseCredentials(): Promise<any>;
    getLLMApiKey(provider?: string): Promise<any>;
    getInfraCredentials(name?: string): Promise<any>;
    getSecret(path: string): Promise<string>;
    getSecretOrNull(path: string): Promise<string | null>;
    putSecret(path: string, value: string): Promise<void>;
}
//# sourceMappingURL=SecretsManager.d.ts.map