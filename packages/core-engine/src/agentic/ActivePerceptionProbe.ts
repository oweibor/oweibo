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

export type ProbeType =
  | 'file-change'
  | 'dependency-drift'
  | 'test-regression'
  | 'service-health'
  | 'resource-pressure';

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

const DEFAULT_CONFIG: ProbeConfig = {
  intervalMs: 30_000,
  enabledProbes: ['file-change', 'test-regression', 'resource-pressure'],
};

export class ActivePerceptionProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: ProbeConfig;
  private lastFileSnapshot: Map<string, number> = new Map();

  constructor(
    private readonly sandbox: ISandbox | null,
    private readonly onProbeResult: (result: ProbeResult) => Promise<void>,
    config: Partial<ProbeConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runProbes(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runProbes(): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    const now = Date.now();

    for (const probeType of this.config.enabledProbes) {
      try {
        const result = await this.executeProbe(probeType, now);
        if (result) {
          results.push(result);
          if (result.significant) {
            await this.onProbeResult(result);
          }
        }
      } catch {
        // Probe failure is non-fatal — log and continue
      }
    }

    return results;
  }

  private async executeProbe(probeType: ProbeType, now: number): Promise<ProbeResult | null> {
    switch (probeType) {
      case 'file-change':
        return this.probeFileChanges(now);
      case 'test-regression':
        return this.probeTestRegression(now);
      case 'resource-pressure':
        return this.probeResourcePressure(now);
      case 'dependency-drift':
        return this.probeDependencyDrift(now);
      case 'service-health':
        return this.probeServiceHealth(now);
      default:
        return null;
    }
  }

  private async probeFileChanges(now: number): Promise<ProbeResult | null> {
    if (!this.config.repoPath || !this.sandbox) return null;

    const result = await this.sandbox.execute(
      `find ${this.config.repoPath}/src -name '*.ts' -newer /tmp/.probe-marker 2>/dev/null | head -20`,
      'bash',
      { timeoutMs: 5000 },
    ).catch(() => null);

    if (!result || result.exitCode !== 0) return null;
    const changedFiles = result.stdout.trim().split('\n').filter(Boolean);

    if (changedFiles.length === 0) return null;

    return {
      probeType: 'file-change',
      timestamp: now,
      significant: changedFiles.length > 0,
      summary: `${changedFiles.length} file(s) changed since last probe`,
      details: { changedFiles },
    };
  }

  private async probeTestRegression(now: number): Promise<ProbeResult | null> {
    if (!this.sandbox) return null;

    const result = await this.sandbox.execute(
      'npx jest --passWithNoTests --json --forceExit 2>/dev/null',
      'node',
      { timeoutMs: 30_000 },
    ).catch(() => null);

    if (!result) return null;

    try {
      const testOutput = JSON.parse(result.stdout);
      const failures = testOutput.numFailedTests ?? 0;
      return {
        probeType: 'test-regression',
        timestamp: now,
        significant: failures > 0,
        summary: failures > 0 ? `${failures} test(s) failing` : 'All tests passing',
        details: { numPassed: testOutput.numPassedTests, numFailed: failures },
      };
    } catch {
      return null;
    }
  }

  private async probeResourcePressure(now: number): Promise<ProbeResult> {
    const { freemem, totalmem } = await import('os');
    const memUsage = 1 - freemem() / totalmem();
    return {
      probeType: 'resource-pressure',
      timestamp: now,
      significant: memUsage > 0.9,
      summary: `Memory usage: ${(memUsage * 100).toFixed(1)}%`,
      details: { memoryUsagePercent: memUsage * 100 },
    };
  }

  private async probeDependencyDrift(_now: number): Promise<ProbeResult | null> {
    // Placeholder — would check npm outdated / lock file changes
    return null;
  }

  private async probeServiceHealth(_now: number): Promise<ProbeResult | null> {
    // Placeholder — would check Qdrant, Redis, Ollama health
    return null;
  }
}
