/**
 * BrowserDlpFilter — PII redaction post-processor applied to all BrowserActionResult fields.
 * (NEW v9.5.5)
 *
 * Scans observation, data string values, and evalResult for five PII categories.
 * Enabled per-tenant via Vault: oweibo/tenants/{tenantId}/browser/dlp-filter-enabled
 */

import type { BrowserActionResult, DlpCategory } from '@oweibo/core-contracts';

interface IVaultClient {
  readOptional(path: string): Promise<unknown>;
}

const DLP_PATTERNS: Array<{ label: DlpCategory; re: RegExp }> = [
  { label: 'email', re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
  { label: 'phone', re: /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { label: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'credit-card', re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
  { label: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]{0,16})?\b/g },
];

export class BrowserDlpFilter {
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly vault: IVaultClient) {}

  async filterResult(
    result: BrowserActionResult,
    tenantId: string,
  ): Promise<BrowserActionResult> {
    if (!(await this.isEnabled(tenantId))) return result;
    return {
      ...result,
      observation: this.redact(result.observation),
      data: result.data ? this.redactRecord(result.data) : undefined,
      evalResult:
        typeof result.evalResult === 'string'
          ? this.redact(result.evalResult)
          : result.evalResult,
    };
  }

  redact(text: string): string {
    let out = text;
    for (const { label, re } of DLP_PATTERNS) {
      // Reset lastIndex for global regexes
      re.lastIndex = 0;
      out = out.replace(re, `[REDACTED:${label}]`);
    }
    return out;
  }

  private redactRecord(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k,
        typeof v === 'string' ? this.redact(v) : v,
      ]),
    );
  }

  private async isEnabled(tenantId: string): Promise<boolean> {
    if (this.cache.has(tenantId)) return this.cache.get(tenantId)!;
    const flag = await this.vault.readOptional(
      `oweibo/tenants/${tenantId}/browser/dlp-filter-enabled`,
    );
    const result = flag === true;
    this.cache.set(tenantId, result);
    return result;
  }

  invalidateTenantCache(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
