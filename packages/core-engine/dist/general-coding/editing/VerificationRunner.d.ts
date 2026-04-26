import type { WarmPoolManager } from '../../sandbox/WarmPoolManager.js';
import type { ISecurityContext } from '@oweibo/core-contracts';
import type { CodeIntelligenceLayer } from '../intelligence/CodeIntelligenceLayer.js';
export interface VerificationResult {
    passed: boolean;
    errors: string[];
    typeErrors: number;
    lintErrors: number;
    testFailures: number;
    testsRun: number;
}
/**
 * VerificationRunner — tsc → eslint → targeted jest loop after every edit.
 *
 * Distinct from factory's StaticGateStage/TDDGateStage — operates on the live working tree.
 * "Targeted jest": only test files that transitively import any of the editedFiles are run.
 *
 * v9.1: Uses CodeIntelligenceLayer import graph for accurate test targeting (BFS traversal).
 * All execution routes through WarmPool sandbox — never on the host directly.
 */
export declare class VerificationRunner {
    private readonly warmPool;
    private readonly codeIntel;
    constructor(warmPool: WarmPoolManager, codeIntel: CodeIntelligenceLayer);
    run(repoRoot: string, editedFiles: string[], secCtx: ISecurityContext): Promise<VerificationResult>;
    /**
     * BFS through the import graph to find all test files that transitively import any edited file.
     */
    private findAffectedTests;
}
//# sourceMappingURL=VerificationRunner.d.ts.map