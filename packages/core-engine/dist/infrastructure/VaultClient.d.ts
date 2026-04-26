/**
 * VaultClient — thin wrapper over HashiCorp Vault KV v2 API.
 * All credential/secret lookups within core-engine route through this client.
 * The concrete implementation is injected at startup; tests substitute a stub.
 */
export interface VaultClient {
    /**
     * Read a secret at the given path.
     * Returns the secret data object, or null if the path does not exist.
     * Throws on network/auth errors so callers can distinguish "absent" from "broken".
     */
    read(path: string): Promise<Record<string, unknown> | null>;
    /**
     * Write a secret at the given path (used by CLI scaffolding, not at runtime).
     */
    write(path: string, data: Record<string, unknown>): Promise<void>;
}
/**
 * NullVaultClient — no-op implementation for local development and testing.
 * All reads return null; writes are discarded silently.
 */
export declare class NullVaultClient implements VaultClient {
    read(_path: string): Promise<null>;
    write(_path: string, _data: Record<string, unknown>): Promise<void>;
}
//# sourceMappingURL=VaultClient.d.ts.map