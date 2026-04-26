"use strict";
/**
 * BrowserDlpFilter — PII redaction post-processor applied to all BrowserActionResult fields.
 * (NEW v9.5.5)
 *
 * Scans observation, data string values, and evalResult for five PII categories.
 * Enabled per-tenant via Vault: oweibo/tenants/{tenantId}/browser/dlp-filter-enabled
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserDlpFilter = void 0;
const DLP_PATTERNS = [
    { label: 'email', re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
    { label: 'phone', re: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
    { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { label: 'credit-card', re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
    { label: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]{0,16})?\b/g },
];
class BrowserDlpFilter {
    vault;
    cache = new Map();
    constructor(vault) {
        this.vault = vault;
    }
    async filterResult(result, tenantId) {
        if (!(await this.isEnabled(tenantId)))
            return result;
        return {
            ...result,
            observation: this.redact(result.observation),
            data: result.data ? this.redactRecord(result.data) : undefined,
            evalResult: typeof result.evalResult === 'string'
                ? this.redact(result.evalResult)
                : result.evalResult,
        };
    }
    redact(text) {
        let out = text;
        for (const { label, re } of DLP_PATTERNS) {
            // Reset lastIndex for global regexes
            re.lastIndex = 0;
            out = out.replace(re, `[REDACTED:${label}]`);
        }
        return out;
    }
    redactRecord(obj) {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [
            k,
            typeof v === 'string' ? this.redact(v) : v,
        ]));
    }
    async isEnabled(tenantId) {
        if (this.cache.has(tenantId))
            return this.cache.get(tenantId);
        const flag = await this.vault.readOptional(`oweibo/tenants/${tenantId}/browser/dlp-filter-enabled`);
        const result = flag === true;
        this.cache.set(tenantId, result);
        return result;
    }
    invalidateTenantCache(tenantId) {
        this.cache.delete(tenantId);
    }
}
exports.BrowserDlpFilter = BrowserDlpFilter;
//# sourceMappingURL=BrowserDlpFilter.js.map