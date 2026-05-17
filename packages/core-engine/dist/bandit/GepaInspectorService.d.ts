import type { Pool } from 'pg';
export interface GepaRun {
    id: string;
    runDate: string;
    status: 'running' | 'completed' | 'failed' | 'budget_exceeded';
    slotsProcessed: number;
    candidatesGenerated: number;
    frontierSize: number;
    costUsd: number;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
}
export interface CandidateRow {
    hash: string;
    role: string;
    slotId: string;
    templateVersion: string;
    parentHash: string | null;
    mutationStatus: string;
    evalScore: Record<string, unknown> | null;
    createdAt: string;
    updatedBy: string | null;
    textPreview: string;
}
export interface CostPoint {
    day: string;
    costUsd: number;
    runs: number;
}
export interface VelocityRow {
    slotId: string;
    velocityTier: 'healthy' | 'slowing' | 'stagnating' | 'converged';
    delta7d: number;
    deltaBaseline: number;
    computedAt: string;
}
export declare class GepaInspectorService {
    private readonly pool;
    constructor(pool: Pool);
    listRuns(limit?: number): Promise<GepaRun[]>;
    listCandidates(filter?: {
        role?: string;
        slotId?: string;
        limit?: number;
    }): Promise<CandidateRow[]>;
    /**
     * All candidates for one (slot, role), ranked by best eval_score axis.
     * Indicates which one is live on each channel pointer.
     */
    slotFrontier(slotId: string, role: string): Promise<{
        candidates: Array<CandidateRow & {
            liveOnChannels: string[];
            banditAlpha?: number;
            banditBeta?: number;
        }>;
        channels: Array<{
            name: string;
            promptHash: string;
            version: string;
        }>;
    }>;
    costSeries(days?: number): Promise<CostPoint[]>;
    velocityTiers(): Promise<VelocityRow[]>;
}
//# sourceMappingURL=GepaInspectorService.d.ts.map