/**
 * FirecrackerSandbox — Track 2 sandbox backend (§7.3).
 *
 * Runs code inside a Firecracker microVM with vsock communication.
 * Provides hardware-level VM isolation via KVM. Requires Firecracker binary,
 * a custom kernel with vsock support, and a rootfs with the guest agent.
 *
 * DEFERRED for initial deployment — GVisorSandbox is the production default.
 */
import { spawn } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import type { ISandbox, ISandboxResult, ISandboxResourceLimits } from '@oweibo/core-contracts';

const DEFAULT_LIMITS: ISandboxResourceLimits = {
  cpuCores: 1, memoryMB: 512, diskMB: 1024,
  timeoutMs: 60_000, networkPolicy: 'none',
};

const VSOCK_PORT = 8080;

export class FirecrackerSandbox implements ISandbox {
  private readonly vmId: string;
  private readonly socketPath: string;
  private readonly overlayDir: string;
  private guestCid: number | null = null;

  constructor(
    private readonly firecrackerBin: string = '/usr/bin/firecracker',
    private readonly kernelPath: string = '/opt/firecracker/vmlinux',
    private readonly rootfsPath: string = '/opt/firecracker/rootfs.ext4',
  ) {
    this.vmId = randomUUID();
    this.socketPath = `/tmp/fc-${this.vmId}.sock`;
    this.overlayDir = `/tmp/fc-overlay-${this.vmId}`;
  }

  async execute(
    script: string,
    runtime: 'node' | 'python3' | 'bash',
    limits: Partial<ISandboxResourceLimits> = {},
  ): Promise<ISandboxResult> {
    const opts = { ...DEFAULT_LIMITS, ...limits };
    const startMs = Date.now();
    const ext = { node: 'js', python3: 'py', bash: 'sh' }[runtime] ?? 'sh';

    await mkdir(this.overlayDir, { recursive: true });
    const hostScriptPath = join(this.overlayDir, `script.${ext}`);
    const guestScriptPath = join('/tmp', `script.${ext}`);

    await writeFile(hostScriptPath, script, 'utf-8');
    await this.bootVM(opts);
    const result = await this.runInsideVM(runtime, guestScriptPath, opts.timeoutMs);
    await this.destroyVM();
    return { ...result, durationMs: Date.now() - startMs };
  }

  async bootVM(limits: ISandboxResourceLimits): Promise<void> {
    this.guestCid = (parseInt(this.vmId.replace(/-/g, '').slice(-6), 16) % 0xFFFF) + 3;

    spawn(this.firecrackerBin, ['--api-sock', this.socketPath, '--log-level', 'Error'], {
      detached: true, stdio: 'ignore',
    }).unref();
    await new Promise(r => setTimeout(r, 200));

    await this.fcAPI('PUT', '/boot-source', {
      kernel_image_path: this.kernelPath,
      boot_args: `console=ttyS0 reboot=k panic=1 pci=off nokaslr quiet VSOCK_CID=${this.guestCid}`,
    });
    await this.fcAPI('PUT', '/drives/rootfs', {
      drive_id: 'rootfs', path_on_host: this.rootfsPath,
      is_root_device: true, is_read_only: true,
    });
    await this.fcAPI('PUT', '/drives/overlay', {
      drive_id: 'overlay', path_on_host: this.overlayDir,
      is_root_device: false, is_read_only: false,
    });
    await this.fcAPI('PUT', '/vsock', {
      vsock_id: 'vsock0', guest_cid: this.guestCid,
      uds_path: `${this.socketPath}.vsock`,
    });
    await this.fcAPI('PUT', '/machine-config', {
      vcpu_count: limits.cpuCores, mem_size_mib: limits.memoryMB,
    });
    await this.fcAPI('PUT', '/actions', { action_type: 'InstanceStart' });
    await this.waitForGuestAgent(8000);
  }

  async destroyVM(): Promise<void> {
    await this.fcAPI('PUT', '/actions', { action_type: 'SendCtrlAltDel' }).catch(() => {});
    spawn('pkill', ['-f', `firecracker.*${this.vmId}`]).unref();
    await rm(this.socketPath, { force: true });
    await rm(`${this.socketPath}.vsock`, { force: true });
    await rm(this.overlayDir, { recursive: true, force: true });
    this.guestCid = null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.execute('echo ok', 'bash', { timeoutMs: 5000, memoryMB: 64 });
      return result.exitCode === 0 && result.stdout.trim() === 'ok' && !result.timedOut;
    } catch {
      return false;
    }
  }

  private async runInsideVM(
    runtime: string, guestScriptPath: string, timeoutMs: number,
  ): Promise<Omit<ISandboxResult, 'durationMs'>> {
    if (this.guestCid === null) throw new Error('[Firecracker] bootVM() must be called first');

    return new Promise((resolve, reject) => {
      const socat = spawn('socat', [
        'STDIO', `UNIX-CONNECT:${this.socketPath}.vsock_${VSOCK_PORT}`,
      ]);

      const cmd = {
        command: runtime === 'node' ? 'node' : runtime,
        args: [guestScriptPath],
        timeout_ms: timeoutMs,
      };
      socat.stdin.write(JSON.stringify(cmd) + '\n');
      socat.stdin.end();

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const settle = (result: Omit<ISandboxResult, 'durationMs'>) => {
        if (!resolved) { resolved = true; resolve(result); }
      };

      socat.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line) as { stream: string; data?: string; exit_code?: number };
            if (msg.stream === 'stdout') stdout += (msg.data ?? '') + '\n';
            if (msg.stream === 'stderr') stderr += (msg.data ?? '') + '\n';
            if (msg.stream === 'exit') {
              settle({ stdout, stderr, exitCode: msg.exit_code ?? -1, memoryPeakMB: 0, timedOut: msg.data === 'timeout' });
            }
          } catch { /* partial JSON — wait for next chunk */ }
        }
      });

      socat.on('error', (err) => {
        if (!resolved) reject(new Error(`[Firecracker] socat error: ${err.message}`));
      });

      socat.on('close', (code) => {
        settle({ stdout, stderr, exitCode: -1, memoryPeakMB: 0, timedOut: code === null });
      });

      setTimeout(() => {
        socat.kill('SIGKILL');
        settle({ stdout, stderr, exitCode: -1, memoryPeakMB: 0, timedOut: true });
      }, timeoutMs + 3000);
    });
  }

  private async waitForGuestAgent(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 150;
    while (Date.now() < deadline) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socat = spawn('socat', [
            '-T', '2', 'STDIO', `UNIX-CONNECT:${this.socketPath}.vsock_${VSOCK_PORT}`,
          ]);
          socat.stdin.write(JSON.stringify({ command: 'echo', args: ['ping'], timeout_ms: 1000 }) + '\n');
          socat.stdin.end();
          socat.stdout.on('data', () => { socat.kill(); resolve(); });
          socat.on('error', reject);
          socat.on('close', (code) => { if (code !== 0) reject(new Error('socat closed non-zero')); });
        });
        return;
      } catch {
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 1000);
      }
    }
    throw new Error(`[Firecracker:${this.vmId}] Guest agent did not respond within ${timeoutMs}ms`);
  }

  private async fcAPI(method: string, apiPath: string, body: unknown): Promise<void> {
    const { fetch: undiciFetch, Agent } = await import('undici');
    const agent = new Agent({ connect: { socketPath: this.socketPath } });
    const res = await undiciFetch(`http://localhost${apiPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: agent as never,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[Firecracker] API ${method} ${apiPath} failed ${res.status}: ${text}`);
    }
  }
}
