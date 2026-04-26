"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantRulesLoader = exports.FileClassifier = void 0;
const minimatch_1 = require("minimatch");
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
class FileClassifier {
    /** Built-in rules — applied after any tenant-supplied rules */
    static DEFAULT_RULES = [
        // Kubernetes / infrastructure manifests
        { pattern: 'k8s/**', role: 'k8s-specialist', reason: 'Kubernetes manifest directory' },
        { pattern: 'helm/**', role: 'k8s-specialist', reason: 'Helm chart directory' },
        { pattern: 'manifests/**', role: 'k8s-specialist', reason: 'Kubernetes manifests directory' },
        { pattern: 'deploy/**/*.yaml', role: 'k8s-specialist', reason: 'Deployment YAML file' },
        { pattern: 'charts/**', role: 'k8s-specialist', reason: 'Helm charts directory' },
        { pattern: 'infra/**/*.yaml', role: 'k8s-specialist', reason: 'Infrastructure YAML' },
        // Database migrations — must never touch application code
        { pattern: 'migrations/**', role: 'db-migration-specialist', reason: 'Database migrations directory' },
        { pattern: 'db/migrate/**', role: 'db-migration-specialist', reason: 'Database migration path' },
        { pattern: '**/*_migration.*', role: 'db-migration-specialist', reason: 'Migration file by name convention' },
        { pattern: '**/*.migration.*', role: 'db-migration-specialist', reason: 'Migration file by extension convention' },
        { pattern: '**/migrate/**', role: 'db-migration-specialist', reason: 'Migrate subdirectory' },
        { pattern: 'prisma/migrations/**', role: 'db-migration-specialist', reason: 'Prisma migration file' },
        { pattern: 'drizzle/**', role: 'db-migration-specialist', reason: 'Drizzle ORM migration directory' },
        // Security policies — application code is read-only for this role
        { pattern: '**/*.rego', role: 'security-policy-specialist', reason: 'OPA Rego policy file' },
        { pattern: 'security/**', role: 'security-policy-specialist', reason: 'Security policy directory' },
        { pattern: 'vault/**', role: 'security-policy-specialist', reason: 'Vault policy directory' },
        { pattern: '**/.policy', role: 'security-policy-specialist', reason: 'Policy file' },
        { pattern: '**/policy/**', role: 'security-policy-specialist', reason: 'Policy subdirectory' },
    ];
    /**
     * classify — returns the first matching rule for the given filePath,
     * or null if no rule matches (general-coder handles the file).
     *
     * @param filePath     Repo-relative file path, e.g. 'k8s/deployment.yaml'
     * @param tenantRules  Tenant-specific rules (Gap 2 fix: loaded per-tenant by
     *                     TenantRulesLoader, not baked into the classifier at
     *                     construction time). Prepended before DEFAULT_RULES.
     */
    classify(filePath, tenantRules = []) {
        const allRules = [...tenantRules, ...FileClassifier.DEFAULT_RULES];
        for (const rule of allRules) {
            if ((0, minimatch_1.minimatch)(filePath, rule.pattern, { matchBase: true })) {
                return { role: rule.role, reason: rule.reason };
            }
        }
        return null;
    }
}
exports.FileClassifier = FileClassifier;
// ── Gap 2 + Gap 6 fix: TenantRulesLoader ─────────────────────────────────────
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
class TenantRulesLoader {
    vault;
    redis;
    static DEFAULT_FALLBACK_TTL_MS = 60_000;
    globalTtlMs = null;
    constructor(vault, redis) {
        this.vault = vault;
        this.redis = redis;
    }
    /** Force a re-read of the global TTL on next load. */
    reload() {
        this.globalTtlMs = null;
    }
    async resolveGlobalTtlMs() {
        if (this.globalTtlMs !== null)
            return this.globalTtlMs;
        let ttl = TenantRulesLoader.DEFAULT_FALLBACK_TTL_MS;
        try {
            const cfg = await this.vault.read('oweibo/infra/file-classifier');
            const raw = cfg?.['cacheTtlMs'];
            const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
            if (Number.isFinite(parsed) && parsed > 0)
                ttl = parsed;
        }
        catch { /* Vault key absent or unreachable — use fallback */ }
        this.globalTtlMs = ttl;
        return ttl;
    }
    async load(tenantId) {
        const cacheKey = `file-classifier-rules:${tenantId}`;
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached)
                return JSON.parse(cached);
        }
        catch { /* cache miss — fall through to Vault */ }
        let rules = [];
        let tenantTtlMs = null;
        try {
            const data = await this.vault.read(`oweibo/tenants/${tenantId}/file-classifier-rules`);
            if (data) {
                // Vault stores as { value: "<json string>" } or { rules: [...] }
                const raw = typeof data['value'] === 'string' ? data['value']
                    : Array.isArray(data['rules']) ? JSON.stringify(data['rules'])
                        : null;
                if (raw)
                    rules = JSON.parse(raw);
                const ttlRaw = data['cacheTtlMs'];
                const ttlParsed = typeof ttlRaw === 'number' ? ttlRaw : typeof ttlRaw === 'string' ? Number(ttlRaw) : NaN;
                if (Number.isFinite(ttlParsed) && ttlParsed > 0)
                    tenantTtlMs = ttlParsed;
            }
        }
        catch { /* Vault key absent — use empty (built-ins apply) */ }
        const effectiveTtl = tenantTtlMs ?? await this.resolveGlobalTtlMs();
        try {
            await this.redis.set(cacheKey, JSON.stringify(rules), 'PX', effectiveTtl);
        }
        catch { /* cache write failure is non-fatal */ }
        return rules;
    }
}
exports.TenantRulesLoader = TenantRulesLoader;
//# sourceMappingURL=FileClassifier.js.map