/**
 * Docker sandbox spawner.
 * Creates isolated containers for Kilo CLI execution via kilo-proxy.
 * Sequential: only one sandbox may run at a time.
 *
 * @module services/sandbox
 */

const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('../config');
const logger = require('./logger');
const { safeJoin, sanitizeSegment } = require('./safePath');

/** @type*/
let docker;

/** @typeCurrently running sandbox container ID */
let activeSandbox = null;

/**
 * Initialize the Docker client.
 * Connects to kilo-proxy via DOCKER_HOST.
 */
function initialize() {
    const url = new URL(config.DOCKER_HOST.replace('tcp://', 'http://'));
    docker = new Docker({
        host: url.hostname,
        port: parseInt(url.port, 10) || 2375,
        protocol: 'http',
    });
    logger.info('Docker sandbox client initialized', { host: config.DOCKER_HOST });
}

/**
 * Fetch a scoped agent JWT from the identity service for use inside the sandbox.
 * Falls back to empty string if identity service is unavailable or not configured.
 */
async function fetchAgentToken(opts: {
    taskId: string;
    runId: string;
    userId: string;
    tenantId: string;
    parentScopes: string[];
    agentProfile: string;
    taskBudgetRemainingMs: number;
}): Promise<string> {
    const endpoint = config.AGENT_TOKEN_ENDPOINT;
    const key      = config.INTERNAL_SERVICE_KEY;

    if (!endpoint || !key) {
        logger.debug('[sandbox] agent token endpoint not configured — skipping');
        return '';
    }

    return new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(opts));
        const url  = new URL(endpoint);
        const mod  = url.protocol === 'https:' ? https : http;

        const req = mod.request({
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': body.length,
                'x-internal-service-key': key,
            },
            timeout: 5_000,
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                try {
                    const { token } = JSON.parse(raw);
                    resolve(token || '');
                } catch {
                    resolve('');
                }
            });
        });

        req.on('error', (err) => {
            logger.warn('[sandbox] agent token fetch failed', { error: err.message });
            resolve('');
        });
        req.on('timeout', () => { req.destroy(); resolve(''); });
        req.write(body);
        req.end();
    });
}

/**
 * Spawn a sandboxed container for Kilo CLI execution.
 *
 * @paramtaskId - Task identifier
 * @paramworkspacePath - Host path to workspace (mounted :ro)
 * @paraminstruction - Task instruction
 * @parammemoryContext - Memory context block
 * @paramtaskContext - Optional principal/task context for agent JWT minting
 * @returns
 * @throwsIf sandbox is already running (409)
 */
async function spawnSandbox(taskId, workspacePath, instruction, memoryContext, taskContext: any = {}) {
    // Sequential enforcement
    if (activeSandbox) {
        const err = new Error('A sandbox is already running. Sequential execution only.');
        (err as any).statusCode = 409;
        throw err;
    }

    const checkpointDir = safeJoin(config.CHECKPOINT_DIR, sanitizeSegment(taskId));
    fs.mkdirSync(checkpointDir, { recursive: true });

    // Write memory context to temp file inside checkpoint dir
    const contextPath = path.join(checkpointDir, 'memory_context.md');
    fs.writeFileSync(contextPath, memoryContext);

    // Mint a scoped agent JWT for this sandbox run
    const runId = `${taskId}-${Date.now()}`;
    const agentToken = await fetchAgentToken({
        taskId,
        runId,
        userId:               taskContext.userId    || 'system',
        tenantId:             taskContext.tenantId  || 'default',
        parentScopes:         taskContext.scopes    || [],
        agentProfile:         taskContext.agentProfile || 'orchestrate',
        taskBudgetRemainingMs: taskContext.budgetMs || 60 * 60 * 1000,
    });

    const containerName = `kilo-sandbox-${taskId}`;

    logger.info('Spawning sandbox', {
        task_id: taskId,
        container: containerName,
        image: config.SANDBOX_IMAGE,
        mem_limit: config.SANDBOX_MEM_LIMIT,
    });

    let container;
    try {
        // Pull image if not present (no-op if cached)
        try {
            await docker.getImage(config.SANDBOX_IMAGE).inspect();
        } catch {
            logger.info('Pulling sandbox image', { image: config.SANDBOX_IMAGE });
            await new Promise<any>((resolve, reject) => {
                docker.pull(config.SANDBOX_IMAGE, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, (err) => {
                        if (err) return reject(err);
                        resolve(null);
                    });
                });
            });
        }

        // Create container with hardened security profile:
        //   - Non-root: USER node (set in the sandbox Dockerfile)
        //   - All Linux capabilities dropped; only the absolute minimum added
        //   - Root filesystem read-only; only /checkpoint is writable (bind mount)
        //   - no-new-privileges: prevents privilege escalation via setuid binaries
        //   - NetworkMode none: no outbound or lateral network access
        container = await docker.createContainer({
            name: containerName,
            Image: config.SANDBOX_IMAGE,
            Cmd: ['sleep', 'infinity'], // Kept alive for exec calls
            User: 'node',              // Non-root — requires sandbox image to have node user
            HostConfig: {
                Memory:     parseMem(config.SANDBOX_MEM_LIMIT),
                MemorySwap: parseMem(config.SANDBOX_MEM_LIMIT), // Disable swap
                Binds: [
                    `${workspacePath}:/workspace:ro`,
                    `${checkpointDir}:/checkpoint:rw`,
                ],
                AutoRemove:      false,  // Manual cleanup preserves logs
                NetworkMode:     'none', // No network in sandbox
                ReadonlyRootfs:  true,   // Immutable container root; writes must go to /checkpoint
                CapDrop:         ['ALL'],
                SecurityOpt:     ['no-new-privileges:true'],
            },
            Env: [
                `TASK_ID=${taskId}`,
                `RUN_ID=${runId}`,
                // Strip control characters; instruction is also passed as a direct argv
                // token in execInSandbox, so this env var is a convenience alias only.
                `INSTRUCTION=${instruction.replace(/[\r\n\0]/g, ' ')}`,
                // Scoped agent JWT — replaces static KILO_API_TOKEN inside the sandbox.
                // Empty string when identity service is not configured (dev mode).
                ...(agentToken ? [`OWEIBO_AGENT_TOKEN=${agentToken}`] : []),
            ],
            WorkingDir: '/workspace',
        });

        activeSandbox = container.id;

        // Start container
        await container.start();
        logger.info('Sandbox started', { task_id: taskId, container_id: container.id });

        return {
            containerId: container.id,
            container,
        };
    } catch (err) {
        activeSandbox = null;
        // Attempt cleanup on failure
        if (container) {
            try {
                await container.remove({ force: true });
            } catch {
                // Best effort
            }
        }
        logger.error('Sandbox spawn failed', { task_id: taskId, error: err.message });
        throw err;
    }
}

/**
 * Execute a command inside the running sandbox.
 *
 * @paramcontainerId
 * @paramcmd - Command array
 * @returns
 */
async function execInSandbox(containerId, cmd) {
    const container = docker.getContainer(containerId);

    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
    });

    return new Promise<any>((resolve, reject) => {
        exec.start({ hijack: true, stdin: false }, (err, stream) => {
            if (err) return reject(err);

            let stdout = '';
            let stderr = '';

            // Demux docker stream
            const { PassThrough } = require('stream');
            const stdoutStream = new PassThrough();
            const stderrStream = new PassThrough();

            container.modem.demuxStream(stream, stdoutStream, stderrStream);

            stdoutStream.on('data', (chunk) => { stdout += chunk.toString(); });
            stderrStream.on('data', (chunk) => { stderr += chunk.toString(); });

            stream.on('end', async () => {
                try {
                    const inspect = await exec.inspect();
                    resolve({
                        exitCode: inspect.ExitCode,
                        stdout,
                        stderr,
                    });
                } catch (inspectErr) {
                    reject(inspectErr);
                }
            });

            stream.on('error', reject);
        });
    });
}

/**
 * Stop and remove the sandbox container.
 *
 * @paramcontainerId
 * @returns
 */
async function cleanupSandbox(containerId) {
    try {
        const container = docker.getContainer(containerId);
        await container.stop({ t: 5 }).catch(() => { /* may already be stopped */ });
        await container.remove({ force: true });
        logger.info('Sandbox cleaned up', { container_id: containerId });
    } catch (err) {
        logger.warn('Sandbox cleanup failed', { container_id: containerId, error: err.message });
    } finally {
        if (activeSandbox === containerId) {
            activeSandbox = null;
        }
    }
}

/**
 * Check if a sandbox is currently running.
 * @returns
 */
function isRunning() {
    return activeSandbox !== null;
}

/**
 * Parse memory string (e.g. "2g") to bytes.
 * @parammem
 * @returns
 */
function parseMem(mem) {
    const match = mem.match(/^(\d+)([gmk]?)$/i);
    if (!match) return 2 * 1024 * 1024 * 1024; // default 2GB
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multipliers = { g: 1024 ** 3, m: 1024 ** 2, k: 1024 };
    return num * (multipliers[unit] || 1);
}

module.exports = { initialize, spawnSandbox, execInSandbox, cleanupSandbox, isRunning };

export {};
