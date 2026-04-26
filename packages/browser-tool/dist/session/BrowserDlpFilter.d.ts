/**
 * BrowserDlpFilter — PII redaction post-processor applied to all BrowserActionResult fields.
 * (NEW v9.5.5)
 *
 * Scans observation, data string values, and evalResult for five PII categories.
 * Enabled per-tenant via Vault: oweibo/tenants/{tenantId}/browser/dlp-filter-enabled
 */
import type { BrowserActionResult } from '@oweibo/core-contracts';
interface IVaultClient {
    readOptional(path: string): Promise<unknown>;
}
export declare class BrowserDlpFilter {
    private readonly vault;
    private readonly cache;
    constructor(vault: IVaultClient);
    filterResult(result: BrowserActionResult, tenantId: string): Promise<BrowserActionResult>;
    redact(text: string): string;
    private redactRecord;
    private isEnabled;
    invalidateTenantCache(tenantId: string): void;
}
export {};
//# sourceMappingURL=BrowserDlpFilter.d.ts.map