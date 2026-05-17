"use strict";
// D.10 — CostAttributor: per-tenant distillation cost metering into usage_records.
// v1 absorbs cost (billed=false); v2 flips to billed via oweibo.billing_config
// without any code change (config-only billing switch).
Object.defineProperty(exports, "__esModule", { value: true });
exports.CostAttributor = void 0;
const DEFAULT_CONFIG = {
    costUsdPerCall: 0.0002, // ~2 LLM calls × Haiku-tier pricing
    billingEnabled: false, // v1: absorb cost
};
class CostAttributor {
    pool;
    config = DEFAULT_CONFIG;
    configLoadedAt = 0;
    CONFIG_TTL_MS = 300_000; // 5-minute cache
    constructor(pool) {
        this.pool = pool;
    }
    /**
     * Record a distillation usage event for the given tenant.
     * Never throws — billing must not block the lesson pipeline.
     */
    async record(tenantId, recordType = 'distillation', quantity = 1, metadata) {
        try {
            const cfg = await this.loadConfig();
            await this.pool.query(`INSERT INTO oweibo.usage_records
           (tenant_id, record_type, quantity, unit, cost_usd, billed, metadata, recorded_at)
         VALUES ($1, $2, $3, 'call', $4, $5, $6, NOW())`, [
                tenantId,
                recordType,
                quantity,
                cfg.costUsdPerCall * quantity,
                cfg.billingEnabled,
                metadata ? JSON.stringify(metadata) : null,
            ]);
        }
        catch (err) {
            // Non-fatal — log but never propagate
            console.warn('[CostAttributor] record failed (suppressed):', String(err));
        }
    }
    async loadConfig() {
        if (Date.now() - this.configLoadedAt < this.CONFIG_TTL_MS)
            return this.config;
        try {
            const result = await this.pool.query(`SELECT key, value FROM oweibo.billing_config
         WHERE key IN ('distillation_billing_enabled', 'distillation_cost_usd_per_call')`);
            const map = Object.fromEntries(result.rows.map(r => [r.key, r.value]));
            this.config = {
                billingEnabled: map['distillation_billing_enabled'] === true || map['distillation_billing_enabled'] === 'true',
                costUsdPerCall: parseFloat(String(map['distillation_cost_usd_per_call'] ?? '0.0002')),
            };
            this.configLoadedAt = Date.now();
        }
        catch {
            // Use cached / default on DB error
        }
        return this.config;
    }
}
exports.CostAttributor = CostAttributor;
//# sourceMappingURL=CostAttributor.js.map