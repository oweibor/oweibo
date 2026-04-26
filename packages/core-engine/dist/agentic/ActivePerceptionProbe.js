"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivePerceptionProbe = void 0;
const DEFAULT_CONFIG = {
    intervalMs: 30_000,
    enabledProbes: ['file-change', 'test-regression', 'resource-pressure'],
};
class ActivePerceptionProbe {
    sandbox;
    onProbeResult;
    timer = null;
    config;
    lastFileSnapshot = new Map();
    constructor(sandbox, onProbeResult, config = {}) {
        this.sandbox = sandbox;
        this.onProbeResult = onProbeResult;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.runProbes(), this.config.intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async runProbes() {
        const results = [];
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
            }
            catch {
                // Probe failure is non-fatal — log and continue
            }
        }
        return results;
    }
    async executeProbe(probeType, now) {
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
    async probeFileChanges(now) {
        if (!this.config.repoPath || !this.sandbox)
            return null;
        const result = await this.sandbox.execute(`find ${this.config.repoPath}/src -name '*.ts' -newer /tmp/.probe-marker 2>/dev/null | head -20`, 'bash', { timeoutMs: 5000 }).catch(() => null);
        if (!result || result.exitCode !== 0)
            return null;
        const changedFiles = result.stdout.trim().split('\n').filter(Boolean);
        if (changedFiles.length === 0)
            return null;
        return {
            probeType: 'file-change',
            timestamp: now,
            significant: changedFiles.length > 0,
            summary: `${changedFiles.length} file(s) changed since last probe`,
            details: { changedFiles },
        };
    }
    async probeTestRegression(now) {
        if (!this.sandbox)
            return null;
        const result = await this.sandbox.execute('npx jest --passWithNoTests --json --forceExit 2>/dev/null', 'node', { timeoutMs: 30_000 }).catch(() => null);
        if (!result)
            return null;
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
        }
        catch {
            return null;
        }
    }
    async probeResourcePressure(now) {
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
    async probeDependencyDrift(_now) {
        // Placeholder — would check npm outdated / lock file changes
        return null;
    }
    async probeServiceHealth(_now) {
        // Placeholder — would check Qdrant, Redis, Ollama health
        return null;
    }
}
exports.ActivePerceptionProbe = ActivePerceptionProbe;
//# sourceMappingURL=ActivePerceptionProbe.js.map