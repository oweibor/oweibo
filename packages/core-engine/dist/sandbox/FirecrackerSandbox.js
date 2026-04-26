"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FirecrackerSandbox = void 0;
/**
 * FirecrackerSandbox — Track 2 sandbox backend (§7.3).
 *
 * Runs code inside a Firecracker microVM with vsock communication.
 * Provides hardware-level VM isolation via KVM. Requires Firecracker binary,
 * a custom kernel with vsock support, and a rootfs with the guest agent.
 *
 * DEFERRED for initial deployment — GVisorSandbox is the production default.
 */
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const crypto_1 = require("crypto");
const path_1 = require("path");
const DEFAULT_LIMITS = {
    cpuCores: 1, memoryMB: 512, diskMB: 1024,
    timeoutMs: 60_000, networkPolicy: 'none',
};
const VSOCK_PORT = 8080;
class FirecrackerSandbox {
    firecrackerBin;
    kernelPath;
    rootfsPath;
    vmId;
    socketPath;
    overlayDir;
    guestCid = null;
    constructor(firecrackerBin = '/usr/bin/firecracker', kernelPath = '/opt/firecracker/vmlinux', rootfsPath = '/opt/firecracker/rootfs.ext4') {
        this.firecrackerBin = firecrackerBin;
        this.kernelPath = kernelPath;
        this.rootfsPath = rootfsPath;
        this.vmId = (0, crypto_1.randomUUID)();
        this.socketPath = `/tmp/fc-${this.vmId}.sock`;
        this.overlayDir = `/tmp/fc-overlay-${this.vmId}`;
    }
    async execute(script, runtime, limits = {}) {
        const opts = { ...DEFAULT_LIMITS, ...limits };
        const startMs = Date.now();
        const ext = { node: 'js', python3: 'py', bash: 'sh' }[runtime] ?? 'sh';
        await (0, promises_1.mkdir)(this.overlayDir, { recursive: true });
        const hostScriptPath = (0, path_1.join)(this.overlayDir, `script.${ext}`);
        const guestScriptPath = (0, path_1.join)('/tmp', `script.${ext}`);
        await (0, promises_1.writeFile)(hostScriptPath, script, 'utf-8');
        await this.bootVM(opts);
        const result = await this.runInsideVM(runtime, guestScriptPath, opts.timeoutMs);
        await this.destroyVM();
        return { ...result, durationMs: Date.now() - startMs };
    }
    async bootVM(limits) {
        this.guestCid = (parseInt(this.vmId.replace(/-/g, '').slice(-6), 16) % 0xFFFF) + 3;
        (0, child_process_1.spawn)(this.firecrackerBin, ['--api-sock', this.socketPath, '--log-level', 'Error'], {
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
    async destroyVM() {
        await this.fcAPI('PUT', '/actions', { action_type: 'SendCtrlAltDel' }).catch(() => { });
        (0, child_process_1.spawn)('pkill', ['-f', `firecracker.*${this.vmId}`]).unref();
        await (0, promises_1.rm)(this.socketPath, { force: true });
        await (0, promises_1.rm)(`${this.socketPath}.vsock`, { force: true });
        await (0, promises_1.rm)(this.overlayDir, { recursive: true, force: true });
        this.guestCid = null;
    }
    async healthCheck() {
        try {
            const result = await this.execute('echo ok', 'bash', { timeoutMs: 5000, memoryMB: 64 });
            return result.exitCode === 0 && result.stdout.trim() === 'ok' && !result.timedOut;
        }
        catch {
            return false;
        }
    }
    async runInsideVM(runtime, guestScriptPath, timeoutMs) {
        if (this.guestCid === null)
            throw new Error('[Firecracker] bootVM() must be called first');
        return new Promise((resolve, reject) => {
            const socat = (0, child_process_1.spawn)('socat', [
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
            const settle = (result) => {
                if (!resolved) {
                    resolved = true;
                    resolve(result);
                }
            };
            socat.stdout.on('data', (chunk) => {
                for (const line of chunk.toString().split('\n').filter(Boolean)) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.stream === 'stdout')
                            stdout += (msg.data ?? '') + '\n';
                        if (msg.stream === 'stderr')
                            stderr += (msg.data ?? '') + '\n';
                        if (msg.stream === 'exit') {
                            settle({ stdout, stderr, exitCode: msg.exit_code ?? -1, memoryPeakMB: 0, timedOut: msg.data === 'timeout' });
                        }
                    }
                    catch { /* partial JSON — wait for next chunk */ }
                }
            });
            socat.on('error', (err) => {
                if (!resolved)
                    reject(new Error(`[Firecracker] socat error: ${err.message}`));
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
    async waitForGuestAgent(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let delay = 150;
        while (Date.now() < deadline) {
            try {
                await new Promise((resolve, reject) => {
                    const socat = (0, child_process_1.spawn)('socat', [
                        '-T', '2', 'STDIO', `UNIX-CONNECT:${this.socketPath}.vsock_${VSOCK_PORT}`,
                    ]);
                    socat.stdin.write(JSON.stringify({ command: 'echo', args: ['ping'], timeout_ms: 1000 }) + '\n');
                    socat.stdin.end();
                    socat.stdout.on('data', () => { socat.kill(); resolve(); });
                    socat.on('error', reject);
                    socat.on('close', (code) => { if (code !== 0)
                        reject(new Error('socat closed non-zero')); });
                });
                return;
            }
            catch {
                await new Promise(r => setTimeout(r, delay));
                delay = Math.min(delay * 1.5, 1000);
            }
        }
        throw new Error(`[Firecracker:${this.vmId}] Guest agent did not respond within ${timeoutMs}ms`);
    }
    async fcAPI(method, apiPath, body) {
        const { fetch: undiciFetch, Agent } = await import('undici');
        const agent = new Agent({ connect: { socketPath: this.socketPath } });
        const res = await undiciFetch(`http://localhost${apiPath}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            dispatcher: agent,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`[Firecracker] API ${method} ${apiPath} failed ${res.status}: ${text}`);
        }
    }
}
exports.FirecrackerSandbox = FirecrackerSandbox;
//# sourceMappingURL=FirecrackerSandbox.js.map