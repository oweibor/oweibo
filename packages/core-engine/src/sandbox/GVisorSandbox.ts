/**
 * GVisorSandbox — Track 1 sandbox backend (§7.2).
 *
 * Runs code in a gVisor-isolated Docker container (runtime: runsc).
 * gVisor intercepts every syscall at a user-space kernel boundary, preventing
 * container-escape exploits without requiring custom kernels or vsock.
 *
 * Setup: `apt install runsc` + add runsc runtime to containerd config.
 */
import { spawn } from 'child_process';
import { writeFile, rm, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import type { ISandbox, ISandboxResult, ISandboxResourceLimits } from '@oweibo/core-contracts';

export class GVisorSandbox implements ISandbox {
  private readonly workDir: string;

  constructor(
    private readonly image: string = 'oweibo/sandbox:node20-python311',
  ) {
    this.workDir = `/tmp/sandbox-${randomUUID()}`;
  }

  async execute(
    script: string,
    runtime: 'node' | 'python3' | 'bash',
    limits: Partial<ISandboxResourceLimits> = {},
  ): Promise<ISandboxResult> {
    const opts = { cpuCores: 1, memoryMB: 512, timeoutMs: 60_000, ...limits };
    const startMs = Date.now();
    const ext = { node: 'js', python3: 'py', bash: 'sh' }[runtime] ?? 'sh';
    const scriptPath = join(this.workDir, `script.${ext}`);

    await mkdir(this.workDir, { recursive: true });
    await writeFile(scriptPath, script, 'utf-8');

    const cmd = runtime === 'node' ? 'node' : runtime === 'python3' ? 'python3' : 'bash';

    return new Promise((resolve) => {
      const proc = spawn('docker', [
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
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

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

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.execute('echo ok', 'bash', { timeoutMs: 3000, memoryMB: 64 });
      return result.exitCode === 0 && result.stdout.trim() === 'ok' && !result.timedOut;
    } catch {
      return false;
    }
  }

  async bootVM(_limits: ISandboxResourceLimits): Promise<void> {
    await mkdir(this.workDir, { recursive: true });
  }

  async destroyVM(): Promise<void> {
    await rm(this.workDir, { recursive: true, force: true });
  }
}
