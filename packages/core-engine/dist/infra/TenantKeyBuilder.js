"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantKeyBuilder = exports.InvalidTenantIdError = void 0;
class InvalidTenantIdError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidTenantIdError';
    }
}
exports.InvalidTenantIdError = InvalidTenantIdError;
class TenantKeyBuilder {
    // ── LTM ───────────────────────────────────────────────────────────────────
    /** Qdrant collection name for a tenant's long-term memory. One collection per tenant. */
    static ltmCollection(tenantId) {
        TenantKeyBuilder.assertValidTenantId(tenantId);
        return `agent-ltm:${tenantId}`;
    }
    // ── Validation helpers ────────────────────────────────────────────────────
    static assertValidTenantId(tenantId) {
        if (!tenantId || /[:/\s'"\\]/.test(tenantId)) {
            throw new InvalidTenantIdError(`Invalid tenantId: "${tenantId}"`);
        }
    }
}
exports.TenantKeyBuilder = TenantKeyBuilder;
//# sourceMappingURL=TenantKeyBuilder.js.map