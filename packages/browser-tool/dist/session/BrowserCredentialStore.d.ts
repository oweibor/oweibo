/**
 * BrowserCredentialStore — AES-256-GCM credential vault adapter.
 * (NEW v9.5.6)
 *
 * Fetches and decrypts per-tenant, per-service credentials.
 * The plaintext BrowserCredential exists only in memory during inject-credentials execution.
 * It is NEVER serialised, logged, or passed through DLP filter.
 */
import type { BrowserCredential } from '@oweibo/core-contracts';
import type { ILogger } from './SessionReaper.js';
interface IVaultClient {
    read(path: string): Promise<unknown>;
    write(path: string, value: unknown): Promise<void>;
}
export declare class BrowserCredentialStore {
    private readonly vault;
    private readonly logger;
    constructor(vault: IVaultClient, logger: ILogger);
    /**
     * Fetch and decrypt a credential.
     * The returned object is transient — never cache it.
     * SECURITY: credential values must not appear in any log or event payload.
     */
    fetch(serviceId: string, tenantId: string): Promise<BrowserCredential>;
    /**
     * Store or update a credential (called via CLI credential-manager tool only).
     */
    store(serviceId: string, tenantId: string, cred: BrowserCredential): Promise<void>;
    delete(serviceId: string, tenantId: string): Promise<void>;
    private decrypt;
    private encrypt;
}
export {};
//# sourceMappingURL=BrowserCredentialStore.d.ts.map