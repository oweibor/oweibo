import type { ILLMClient } from '@oweibo/core-contracts';
import type { Pool } from 'pg';
import { type EvalRunResult } from './eval/EvalRunner.js';
export interface PromptVariant {
    readonly hash: string;
    readonly text: string;
    readonly parentHash?: string;
    readonly role: string;
    readonly slotId: string;
    readonly generation: number;
    /** Vendor that produced this variant via reflection. */
    readonly reflectionVendor?: string;
}
export interface ParetoScore {
    readonly qualityPassRate: number;
    readonly qualityScoreMean: number;
    readonly tokensP50: number;
    readonly tokensP95: number;
}
export interface FrontierVariant extends PromptVariant {
    readonly evalResult: EvalRunResult;
    readonly paretoScore: ParetoScore;
    readonly embedding?: number[];
}
export interface OptimizerConfig {
    readonly role: string;
    readonly slotId: string;
    readonly populationSize: number;
    readonly maxGenerations: number;
    readonly vendorPanel: readonly string[];
    readonly budgetCapUsd: number;
    readonly costPerMTokenUsd: number;
}
export interface OptimizerDeps {
    readonly evalLlm: ILLMClient;
    readonly reflectionLlm: ILLMClient;
    readonly pool: Pool;
    readonly getEmbedding: (text: string) => Promise<number[]>;
    readonly getLessons: (role: string, slotId: string, limit: number) => Promise<string[]>;
    readonly getIncumbentText: (role: string, slotId: string) => Promise<string>;
}
export declare class PromptSlotOptimizer {
    private readonly config;
    private readonly deps;
    private readonly cache;
    constructor(config: OptimizerConfig, deps: OptimizerDeps);
    runOneGeneration(generation: number, currentFrontier: FrontierVariant[], failureTraces: string[]): Promise<FrontierVariant[]>;
    private generateCandidate;
}
//# sourceMappingURL=GEPAOptimizer.d.ts.map