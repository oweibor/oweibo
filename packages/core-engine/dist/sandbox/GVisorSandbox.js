"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GVisorSandbox = void 0;
/**
 * GVisorSandbox — Track 1 sandbox backend (§7.2).
 *
 * Runs code in a gVisor-isolated Docker container (runtime: runsc).
 * gVisor intercepts every syscall at a user-space kernel boundary, preventing
 * container-escape exploits without requiring custom kernels or vsock.
 *
 * Setup: `apt install runsc` + add runsc runtime to containerd config.
 */
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const crypto_1 = require("crypto");
const path_1 = require("path");
class GVisorSandbox {
    image;
    workDir;
    constructor(image = 'oweibo/sandbox:node20-python311') {
        this.image = image;
        this.workDir = `/tmp/sandbox-${(0, crypto_1.randomUUID)()}`;
    }
    async execute(script, runtime, limits = {}) {
        const opts = { cpuCores: 1, memoryMB: 512, timeoutMs: 60_000, ...limits };
        const startMs = Date.now();
        const ext = { node: 'js', python3: 'py', bash: 'sh' }[runtime] ?? 'sh';
        const scriptPath = (0, path_1.join)(this.workDir, `script.${ext}`);
        await (0, promises_1.mkdir)(this.workDir, { recursive: true });
        await (0, promises_1.writeFile)(scriptPath, script, 'utf-8');
        const cmd = runtime === 'node' ? 'node' : runtime === 'python3' ? 'python3' : 'bash';
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)('docker', [
                'run', '--rm',
                '--runtime=runsc',
                `--memory=${opts.memoryMB}m`,
                `--cpus=${opts.cpuCores}`,
                '--network=none',
                '--read-only',
                '--tmpfs=/tmp:size=256m,noexec',
                '--security-opt=no-new-privileges',
                '-v', `${this.workDir}:/workspace:ro`,
                this.image,
                cmd, `/workspace/script.${ext}`,
            ], { timeout: opts.timeoutMs });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve({ stdout, stderr, exitCode: -1, durationMs: Date.now() - startMs, memoryPeakMB: 0, timedOut: true });
            }, opts.timeoutMs + 2000);
            proc.on('close', (exitCode) => {
                clearTimeout(timer);
                resolve({ stdout, stderr, exitCode: exitCode ?? -1, durationMs: Date.now() - startMs, memoryPeakMB: 0, timedOut: false });
            });
        });
    }
    async healthCheck() {
        try {
            const result = await this.execute('echo ok', 'bash', { timeoutMs: 3000, memoryMB: 64 });
            return result.exitCode === 0 && result.stdout.trim() === 'ok' && !result.timedOut;
        }
        catch {
            return false;
        }
    }
    async bootVM(_limits) {
        await (0, promises_1.mkdir)(this.workDir, { recursive: true });
    }
    async destroyVM() {
        await (0, promises_1.rm)(this.workDir, { recursive: true, force: true });
    }
}
exports.GVisorSandbox = GVisorSandbox;
//# sourceMappingURL=GVisorSandbox.js.map