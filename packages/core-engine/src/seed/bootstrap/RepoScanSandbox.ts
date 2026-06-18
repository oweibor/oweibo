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
      | 'malformed_sandbox_output'
      | 'invalid_repo_url',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`RepoScanError(${reason}): ${message}`);
    this.name = 'RepoScanError';
  }
}

/**
 * Reject tenant-supplied repo URLs that could be interpreted as git
 * options or shell metachars. Belt-and-braces against the documented
 * `git clone $REPO_URL` pattern inside the container — even with
 * `--end-of-options`, an attacker who controls the URL string can do
 * damage via `ext::sh`, `--upload-pack=`, or values that begin with
 * `-` (treated as a flag).
 *
 * Allowed: https:// and http:// (the public repo-fetch surfaces) plus
 * `git@host:owner/repo` SSH form. Everything else (file://, ext::,
 * leading `-`, embedded whitespace/control chars, `;`, `|`, `` ` ``,
 * `$`, `\n`) is rejected at sandbox boundary.
 */
export function validateRepoUrl(repoUrl: string): { ok: true } | { ok: false; reason: string } {
  if (typeof repoUrl !== 'string') return { ok: false, reason: 'not a string' };
  if (repoUrl.length === 0)        return { ok: false, reason: 'empty' };
  if (repoUrl.length > 2048)       return { ok: false, reason: 'exceeds 2048 chars' };
  if (repoUrl.startsWith('-'))     return { ok: false, reason: 'starts with `-` (would be parsed as a CLI flag)' };
  // Reject any control char, whitespace, shell metachar, or backslash.
  if (/[\s\x00-\x1f\x7f`$;|&<>\\]/.test(repoUrl)) {
    return { ok: false, reason: 'contains whitespace, control char, or shell metachar' };
  }
  // Reject git's own special remote-helper schemes that allow shell execution.
  if (/^(ext|local|file|gitfile|ssh\+local|filter)::/i.test(repoUrl)) {
    return { ok: false, reason: 'unsupported git remote-helper scheme' };
  }
  // Allow exactly: https://, http://, or git@host:owner/repo (SSH short form).
  const httpsOk = /^https?:\/\/[A-Za-z0-9.\-_]+(:\d+)?\/[A-Za-z0-9._\-\/]+(?:\.git)?$/.test(repoUrl);
  const sshOk   = /^git@[A-Za-z0-9.\-_]+:[A-Za-z0-9._\-\/]+(?:\.git)?$/.test(repoUrl);
  if (!httpsOk && !sshOk) {
    return { ok: false, reason: 'must match https://host/path, http://host/path, or git@host:owner/repo' };
  }
  return { ok: true };
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
    // Validate tenant-supplied URL BEFORE forwarding to the container.
    // Catches git-option injection (`--upload-pack=…`), remote-helper
    // schemes (`ext::sh -c …`), and shell metachars. Matches the
    // documented F.5.10a contract clause 6 ("never execute repo
    // content") at the sandbox boundary, not inside the container.
    const v = validateRepoUrl(spec.repoUrl);
    if (!v.ok) {
      throw new RepoScanError('invalid_repo_url', v.reason, { repoUrl: spec.repoUrl });
    }

    const timeoutMs = spec.timeoutMs ?? REPO_SCAN_DEFAULTS.WALL_CLOCK_MS;
    const docker = this.opts.dockerBinary ?? 'docker';
    const args: string[] = [
      'run',
      '--rm',
      '--read-only',
      // Plan §F.5.10a specifies `--network=none` for cross-platform
      // sandboxing. The container image is responsible for
      // pre-fetching the repo (e.g. via a volume-mounted tarball
      // produced by an out-of-band fetcher that DOES have egress).
      // Bridge was the previous (incorrect) default — it grants full
      // outbound, which violates the file-header contract clause 7
      // ("outbound only to the repo URL host; no other DNS"). Custom
      // bridges with iptables-based egress restrictions can be wired
      // via `extraDockerArgs`.
      `--network=none`,
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
    // Use a syntactically-valid but deliberately-unreachable URL so the
    // tightened validateRepoUrl() doesn't short-circuit the probe.
    // Expected outcomes: sandbox_exit_nonzero (container ran + git
    // clone failed) or wall_clock_exceeded (image still pulling) —
    // both confirm the runtime is wired. The only distinguishing
    // failure mode we care about is container_runtime_unavailable.
    await sandbox.scan({ repoUrl: 'https://probe.invalid/_/_.git', timeoutMs: 2_000 });
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
