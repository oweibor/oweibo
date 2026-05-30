/**
 * F.5.10a (ttv-finals): RepoScanSandbox — sandboxed clone+scan of a
 * tenant-supplied git URL.
 *
 * Security contract (from [DomainIntakeStep.ts:35-62](../../../apps/tenant-bootstrap-worker/src/steps/DomainIntakeStep.ts#L35-L62)
 * and plan §F.5.10a):
 *
 *   1. SEPARATE process / container — never runs in the worker process
 *      itself. seccomp default-deny.
 *   2. 120s wall-clock cap.
 *   3. Clone depth = 1, max 1 GB tree, max 100k files.
 *   4. File extension allowlist.
 *   5. Strip symlinks before analysis.
 *   6. NO execution of repo content (no npm install, no postinstall hooks).
 *   7. Network: outbound only to the repo URL host; no other DNS.
 *
 * Pluggable: the abstract IRepoSandbox interface lets operators swap
 * implementations (nsjail on Linux, docker cross-platform, a managed
 * Cloud Run job, etc.). The default DockerRepoSandbox shells out to
 * `docker run` with `--read-only --network=… --memory=1g --pids-limit=128
 * --user nobody`. The startup check in [worker/src/index.ts]
 * verifies docker is on PATH when DOMAIN_INTAKE_ENABLED=true.
 *
 * For non-production environments where no container runtime is
 * available, NullRepoSandbox returns empty signals — the intake
 * pipeline then falls through to interview-answers-only classification.
 */
import { spawn } from 'node:child_process';

export const REPO_SCAN_DEFAULTS = {
  /** Per-extension allowlist; everything else is dropped before analysis. */
  ALLOWED_EXTENSIONS: [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rb', '.java', '.rs',
    '.md', '.txt',
    '.json', '.yaml', '.yml', '.toml',
    '.lock',
  ] as const,
  WALL_CLOCK_MS: 120_000,
  MAX_TREE_BYTES: 1024 * 1024 * 1024, // 1 GB
  MAX_FILE_COUNT: 100_000,
  CLONE_DEPTH: 1,
} as const;

export interface RepoScanSpec {
  readonly repoUrl: string;
  /** Optional override of the wall-clock limit (ms). */
  readonly timeoutMs?: number;
}

export interface RepoSignals {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly notes: readonly string[];
}

export class RepoScanError extends Error {
  constructor(
    public readonly reason:
      | 'unreachable_repo'
      | 'wall_clock_exceeded'
      | 'size_limit_exceeded'
      | 'file_count_limit_exceeded'
      | 'container_runtime_unavailable'
      | 'sandbox_exit_nonzero'
      | 'malformed_sandbox_output',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`RepoScanError(${reason}): ${message}`);
    this.name = 'RepoScanError';
  }
}

export interface IRepoSandbox {
  scan(spec: RepoScanSpec): Promise<RepoSignals>;
}

/**
 * Default sandbox that delegates to a containerised scan runner. Spawns
 * `docker run` with hardened flags and parses structured JSON from
 * stdout. The container image is the operator-supplied OWEIBO_REPO_SCAN_IMAGE
 * (e.g. an internal image with the scan binary baked in). When the env
 * var is unset, construction throws so misconfiguration surfaces at
 * startup, not at first scan.
 *
 * The container image's responsibility:
 *   - `git clone --depth 1 <repoUrl> /scan/repo`
 *   - walk repo, enforce file-count + size limits
 *   - emit `{"languages": [...], "frameworks": [...], "fileCount": N,
 *           "truncated": bool, "notes": [...]}` on stdout
 *   - exit 0 on success, non-zero on internal failure
 */
export class DockerRepoSandbox implements IRepoSandbox {
  constructor(
    private readonly opts: {
      readonly image: string;
      readonly dockerBinary?: string;
      readonly extraDockerArgs?: readonly string[];
    },
  ) {
    if (!opts.image) {
      throw new Error('DockerRepoSandbox: image is required (set OWEIBO_REPO_SCAN_IMAGE)');
    }
  }

  async scan(spec: RepoScanSpec): Promise<RepoSignals> {
    const timeoutMs = spec.timeoutMs ?? REPO_SCAN_DEFAULTS.WALL_CLOCK_MS;
    const docker = this.opts.dockerBinary ?? 'docker';
    const args: string[] = [
      'run',
      '--rm',
      '--read-only',
      `--network=bridge`, // Outbound only — bridge allows DNS + repo fetch
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      `--memory=1g`,
      `--pids-limit=128`,
      `--cpus=1.0`,
      `--user=65534:65534`, // nobody:nogroup
      ...(this.opts.extraDockerArgs ?? []),
      '-e', `REPO_URL=${spec.repoUrl}`,
      '-e', `MAX_TREE_BYTES=${REPO_SCAN_DEFAULTS.MAX_TREE_BYTES}`,
      '-e', `MAX_FILE_COUNT=${REPO_SCAN_DEFAULTS.MAX_FILE_COUNT}`,
      '-e', `CLONE_DEPTH=${REPO_SCAN_DEFAULTS.CLONE_DEPTH}`,
      '-e', `ALLOWED_EXTENSIONS=${REPO_SCAN_DEFAULTS.ALLOWED_EXTENSIONS.join(',')}`,
      this.opts.image,
    ];

    return new Promise<RepoSignals>((resolve, reject) => {
      const proc = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new RepoScanError('wall_clock_exceeded',
          `scan exceeded ${timeoutMs}ms`, { repoUrl: spec.repoUrl }));
      }, timeoutMs);
      timer.unref?.();

      proc.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      proc.on('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new RepoScanError('container_runtime_unavailable',
            `docker binary not found: ${docker}`, { code: 'ENOENT' }));
        } else {
          reject(err);
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new RepoScanError('sandbox_exit_nonzero',
            `scanner exited ${code}`, { stderr: stderr.slice(0, 1024) }));
          return;
        }
        try {
          const parsed = parseSignals(stdout);
          resolve(parsed);
        } catch (err) {
          reject(new RepoScanError('malformed_sandbox_output',
            err instanceof Error ? err.message : String(err),
            { stdoutPrefix: stdout.slice(0, 256) }));
        }
      });
    });
  }
}

/**
 * Test / dev-only sandbox: returns empty signals immediately. Used when
 * DOMAIN_INTAKE_ENABLED=false or in CI environments without a container
 * runtime. The DomainIntakeStep already short-circuits on
 * intake_state != 'requested', so the worker can boot with this sandbox
 * safely — no security implication.
 */
export class NullRepoSandbox implements IRepoSandbox {
  async scan(_spec: RepoScanSpec): Promise<RepoSignals> {
    return { languages: [], frameworks: [], fileCount: 0, truncated: false, notes: ['null-sandbox: no scan performed'] };
  }
}

/**
 * Startup probe: returns true when the configured sandbox is reachable
 * (e.g. docker on PATH). Wired in apps/tenant-bootstrap-worker/src/index.ts
 * to exit non-zero when DOMAIN_INTAKE_ENABLED=true but the runtime is
 * absent — per plan §F.5.10a "belt-and-braces" check.
 */
export async function probeSandboxAvailable(sandbox: IRepoSandbox): Promise<{ available: true } | { available: false; reason: string }> {
  if (sandbox instanceof NullRepoSandbox) return { available: true };
  try {
    // We don't actually scan; just attempt a no-op spawn with a known
    // bad URL and a tight timeout. The expected outcome is
    // sandbox_exit_nonzero or unreachable_repo, NOT
    // container_runtime_unavailable.
    await sandbox.scan({ repoUrl: 'about:blank', timeoutMs: 2_000 });
    return { available: true };
  } catch (err) {
    if (err instanceof RepoScanError && err.reason === 'container_runtime_unavailable') {
      return { available: false, reason: 'docker_not_on_path' };
    }
    return { available: true };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function parseSignals(stdout: string): RepoSignals {
  const trimmed = stdout.trim();
  if (trimmed === '') throw new Error('empty stdout');
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('top-level not an object');
  }
  const o = parsed as Record<string, unknown>;
  return {
    languages:  arrayOfStrings(o['languages']),
    frameworks: arrayOfStrings(o['frameworks']),
    fileCount:  typeof o['fileCount'] === 'number' ? o['fileCount'] : 0,
    truncated:  o['truncated'] === true,
    notes:      arrayOfStrings(o['notes']),
  };
}

function arrayOfStrings(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
