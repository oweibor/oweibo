/**
 * SandboxFactory — backend selection via Vault (§7.2b).
 *
 * Reads SANDBOX_BACKEND from Vault and constructs the appropriate ISandbox.
 * All consuming code calls createSandbox() — never instantiates a concrete class directly.
 * Switching from gVisor to Firecracker = one Vault key change + pool drain/refill.
 */
import type { ISandbox } from '@oweibo/core-contracts';
import type { SecretsManager } from '../secrets/SecretsManager.js';
export type SandboxBackend = 'gvisor' | 'firecracker';
export declare class SandboxFactory {
    private readonly secrets;
    private backend;
    constructor(secrets: SecretsManager);
    createSandbox(): Promise<ISandbox>;
    drainPool(): Promise<void>;
}
//# sourceMappingURL=SandboxFactory.d.ts.map