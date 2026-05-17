import type { ILLMClient } from '@oweibo/core-contracts';
export type EvalTaskCategory = 'decomposition' | 'tool_selection' | 'error_recovery' | 'regression' | 'safety' | 'injected_failure';
export interface EvalTask {
    readonly id: string;
    readonly category: EvalTaskCategory;
    readonly instruction: string;
    readonly goldenOutput?: string;
    /** Split assignment. Holdout tasks are never used in GEPA training. */
    readonly split: 'train' | 'holdout';
}
export interface EvalScore {
    readonly taskId: string;
    readonly qualityPass: boolean;
    readonly qualityScore: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly latencyMs: number;
    readonly promptHash: string;
    readonly evalSuiteVersion: string;
    /** SHA256 of the agent output — used by C.1a determinism verification. */
    readonly outputHash: string;
}
export interface EvalRunResult {
    readonly promptHash: string;
    readonly evalSuiteVersion: string;
    readonly scores: EvalScore[];
    readonly qualityPassRate: number;
    readonly qualityScoreMean: number;
    readonly tokensP50: number;
    readonly tokensP95: number;
}
/** Current eval suite version — bump on any task addition. */
export declare const EVAL_SUITE_VERSION = "1.0.0";
/** Eval tasks. 80% train, 20% holdout. Holdout rotated 25% weekly. */
export declare const EVAL_TASKS: readonly EvalTask[];
/**
 * Run a single eval task against the provided prompt and LLM.
 */
export declare function runEvalTask(task: EvalTask, systemPrompt: string, llm: ILLMClient, promptHash: string): Promise<EvalScore>;
/**
 * Run all training-split eval tasks and return aggregate scores.
 */
export declare function runEvalSuite(systemPrompt: string, llm: ILLMClient, promptHash: string, split?: 'train' | 'holdout' | 'all'): Promise<EvalRunResult>;
//# sourceMappingURL=EvalRunner.d.ts.map