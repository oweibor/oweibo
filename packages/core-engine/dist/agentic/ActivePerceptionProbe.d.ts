/**
 * ActivePerceptionProbe — proactive environmental perception (§16c, Gap §2).
 *
 * Runs periodic probes during task execution to detect environmental changes
 * that may affect the current plan: file changes, dependency updates,
 * new test failures, or external service state changes.
 *
 * Feeds probe results into the CognitiveEngine's re-planning loop.
 */
import type { ISandbox } from '@oweibo/core-contracts';
export type ProbeType = 'file-change' | 'dependency-drift' | 'test-regression' | 'service-health' | 'resource-pressure';
export interface ProbeResult {
    readonly probeType: ProbeType;
    readonly timestamp: number;
    readonly significant: boolean;
    readonly summary: string;
    readonly details: Record<string, unknown>;
}
export interface ProbeConfig {
    readonly intervalMs: number;
    readonly enabledProbes: ProbeType[];
    readonly repoPath?: string;
}
export declare class ActivePerceptionProbe {
    private readonly sandbox;
    private readonly onProbeResult;
    private timer;
    private readonly config;
    private lastFileSnapshot;
    constructor(sandbox: ISandbox | null, onProbeResult: (result: ProbeResult) => Promise<void>, config?: Partial<ProbeConfig>);
    start(): void;
    stop(): void;
    runProbes(): Promise<ProbeResult[]>;
    private executeProbe;
    private probeFileChanges;
    private probeTestRegression;
    private probeResourcePressure;
    private probeDependencyDrift;
    private probeServiceHealth;
}
//# sourceMappingURL=ActivePerceptionProbe.d.ts.map