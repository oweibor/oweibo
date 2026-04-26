import type { AgentRole, FileClassifierRule } from '@oweibo/core-contracts';
import type { VaultClient } from '../infrastructure/VaultClient.js';
import type { Redis } from 'ioredis';
/**
 * FileClassifier — maps file paths to specialist AgentRoles.
 *
 * Classification is pure pattern matching — zero LLM calls, zero async I/O,
 * zero latency. Called synchronously inside maybeAmendDag() per newly
 * discovered file.
 *
 * Rules are evaluated in order; first match wins. Tenant-supplied rules are
 * prepended (higher priority than built-in rules). Tenant rules are loaded
 * separately via TenantRulesLoader and passed as a second argument — this
 * keeps FileClassifier stateless and multi-tenant safe.
 *
 * Returns null when no rule matches — caller treats this as 'general-coder'.
 */
export declare class FileClassifier {
    /** Built-in rules — applied after any tenant-supplied rules */
    private static readonly DEFAULT_RULES;
    /**
     * classify — returns the first matching rule for the given filePath,
     * or null if no rule matches (general-coder handles the file).
     *
     * @param filePath     Repo-relative file path, e.g. 'k8s/deployment.yaml'
     * @param tenantRules  Tenant-specific rules (Gap 2 fix: loaded per-tenant by
     *                     TenantRulesLoader, not baked into the classifier at
     *                     construction time). Prepended before DEFAULT_RULES.
     */
    classify(filePath: string, tenantRules?: FileClassifierRule[]): {
        role: AgentRole;
        reason: string;
    } | null;
}
/**
 * TenantRulesLoader — loads per-tenant FileClassifierRules from Vault with a
 * Redis TTL cache. Prevents the single-tenant startup-load bug (Gap 2) and
 * stale rule issue (Gap 6).
 *
 * Cache key: `file-classifier-rules:{tenantId}` (Redis string, JSON-encoded).
 * On cache miss or TTL expiry: loads from Vault at
 *   oweibo/tenants/{tenantId}/file-classifier-rules
 * Falls back to [] (empty — built-in rules apply) if Vault key is absent.
 *
 * Gap 6 (v9.5.2): TTL is configurable via Vault.
 *   Global default: oweibo/infra/file-classifier.cacheTtlMs (number, ms)
 *   Per-tenant override: oweibo/tenants/{tenantId}/file-classifier-rules.cacheTtlMs
 *   Fallback: 60_000 ms when both keys are absent.
 *   Global default is cached in-process for the lifetime of the loader
 *   (re-resolved only on explicit reload()) since it changes rarely.
 */
export declare class TenantRulesLoader {
    private readonly vault;
    private readonly redis;
    private static readonly DEFAULT_FALLBACK_TTL_MS;
    private globalTtlMs;
    constructor(vault: VaultClient, redis: Redis);
    /** Force a re-read of the global TTL on next load. */
    reload(): void;
    private resolveGlobalTtlMs;
    load(tenantId: string): Promise<FileClassifierRule[]>;
}
//# sourceMappingURL=FileClassifier.d.ts.map