"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeedCohortAssigner = void 0;
/**
 * T.5.e: SeedCohortAssigner — deterministic per-tenant A/B cohort assignment
 * for the seed-memory rollout trial.
 *
 * The platform team needs empirical evidence that the T.2.a seed install
 * actually shortens TTV. Without a control arm, we are investing engineering
 * effort in seeds without proof. This assigner produces:
 *   - 'seeded'  : tenant receives the full T.2.a seed install (default)
 *   - 'control' : tenant skips SeedMemoriesStep (cohort logged for analysis)
 *   - 'exempt'  : internal / synthetic tenants excluded from cohort stats
 *
 * Assignment is SHA256(tenantId) mod 2 — uniform across UUIDs, reproducible,
 * and unbiased by creation order. The feature flag SEED_AB_ENABLED gates the
 * cohorting: when off, every tenant lands in 'seeded' (matches today's
 * intended default).
 *
 * After the trial ends (~200 tenants or 90 days, whichever first), the
 * promotion criterion in ttv.md §T.5.e is evaluated by the analysis
 * subcommand. If positive, the assigner is left as-is. If negative, the
 * platform team revisits the seed catalog content.
 */
const crypto_1 = require("crypto");
class SeedCohortAssigner {
    isEnabled;
    exempt;
    constructor(opts = {}) {
        this.isEnabled = opts.isEnabled ?? defaultEnabled;
        this.exempt = opts.exemptTenantIds ?? new Set();
    }
    /**
     * Deterministically assign a cohort to a tenant id. Same input always
     * yields the same output across processes — the assigner is safe to call
     * from any service (tenant-create handler, backfill script, analysis).
     */
    assign(tenantId) {
        if (this.exempt.has(tenantId))
            return 'exempt';
        if (!this.isEnabled())
            return 'seeded';
        // SHA256 → first byte → bit 0 picks the cohort. SHA256 is uniform over
        // valid UUIDs so the parity of the first byte is fair.
        const digest = (0, crypto_1.createHash)('sha256').update(tenantId).digest();
        const bit = digest[0] & 1;
        return bit === 0 ? 'seeded' : 'control';
    }
}
exports.SeedCohortAssigner = SeedCohortAssigner;
function defaultEnabled() {
    return process.env['SEED_AB_ENABLED'] === 'true';
}
//# sourceMappingURL=SeedCohortAssigner.js.map