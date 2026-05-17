import type { Pool } from 'pg';
export type ModelTier = 'small' | 'mid' | 'large';
export interface ModelArm {
    readonly tier: ModelTier;
    readonly modelId: string;
    alpha: number;
    beta: number;
}
export interface ModelDrawResult {
    readonly tier: ModelTier;
    readonly modelId: string;
}
export declare class ModelBanditService {
    private readonly pool;
    constructor(pool: Pool);
    /**
     * Draw a model tier for the given task category using Thompson sampling.
     * Falls back to DEFAULT_TIER_MAP on DB failure or empty arm table.
     * 5% forced exploration; deterministic on (taskId, category) seed.
     */
    draw(taskId: string, category: string): Promise<ModelDrawResult>;
    /**
     * E.2: Record task outcome for a model tier selection.
     * Idempotent via model_bandit_events PK.
     */
    recordReward(params: {
        taskId: string;
        category: string;
        tier: ModelTier;
        modelId: string;
        reward: number;
    }): Promise<void>;
    private loadArms;
}
//# sourceMappingURL=ModelBanditService.d.ts.map