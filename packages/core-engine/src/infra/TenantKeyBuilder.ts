/**
 * TenantKeyBuilder — canonical factory for all Redis and Qdrant key/collection names.
 *
 * All key construction routes through static methods here so that:
 *   a) ESLint can enforce the no-raw-redis-key / no-raw-scope-string rules.
 *   b) Renaming a key pattern is a one-line change.
 *
 * Methods are added incrementally as each subsystem is implemented.
 * Full specification: §3 of oweibo_memory_subsystem_v9_5_complete.
 */

export class InvalidTenantIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantIdError';
  }
}

export class TenantKeyBuilder {
  // ── LTM ───────────────────────────────────────────────────────────────────

  /** Qdrant collection name for a tenant's long-term memory. One collection per tenant. */
  static ltmCollection(tenantId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    return `agent-ltm:${tenantId}`;
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  private static assertValidTenantId(tenantId: string): void {
    if (!tenantId || /[:/\s'"\\]/.test(tenantId)) {
      throw new InvalidTenantIdError(`Invalid tenantId: "${tenantId}"`);
    }
  }
}
