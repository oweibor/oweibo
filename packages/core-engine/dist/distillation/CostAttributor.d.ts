import type { Pool } from 'pg';
export type RecordType = 'distillation' | 'eval' | 'model_inference' | 'gepa_mutation' | 'pattern_aggregation';
export interface CostAttributorConfig {
    /** Flat USD cost per distillation call. Loaded from oweibo.billing_config. */
    costUsdPerCall: number;
    /** When true, records are marked billed=true in usage_records. */
    billingEnabled: boolean;
}
export declare class CostAttributor {
    private readonly pool;
    private config;
    private configLoadedAt;
    private readonly CONFIG_TTL_MS;
    constructor(pool: Pool);
    /**
     * Record a distillation usage event for the given tenant.
     * Never throws — billing must not block the lesson pipeline.
     */
    record(tenantId: string, recordType?: RecordType, quantity?: number, metadata?: Record<string, unknown>): Promise<void>;
    private loadConfig;
}
//# sourceMappingURL=CostAttributor.d.ts.map