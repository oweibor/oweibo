/**
 * F.2.4 — DeployHealthCheckVerifier.
 *
 * Post-execution verifier for `deploy.*` actions. Polls a tenant-supplied
 * health URL N seconds after the deploy lands and compares the response
 * against an expected shape.
 *
 * Applies to: actionClass starts with `deploy.`.
 *
 * Verifier config (passed via payload.verifierConfig at queue-time):
 *
 *   {
 *     healthUrl:           string;            // absolute URL to poll
 *     expectedStatus?:     number;            // default 200
 *     expectedJsonBody?:   Readonly<Record<string, unknown>>;
 *                                            // structural match: every key in
 *                                            // expectedJsonBody must equal the
 *                                            // corresponding key in the response.
 *     timeoutMs?:          number;            // default 10_000
 *   }
 *
 * Severity assignment
 *   0  status + body matched exactly
 *   2  status matched but body has minor diff (one or more expectedJsonBody
 *      fields disagreed)
 *   3  HTTP error / network failure / status mismatch / body mismatch on a
 *      monitor-flagged field (heuristic: any key whose path contains
 *      'healthy' or 'ready' or 'status')
 *
 * Deferred timing: default 60s after the action executes (allows the
 * deploy to settle).
 */
import type {
  DeferredVerifierInput,
  DriftSeverity,
  IPostExecutionVerifier,
  ImmediateVerifierInput,
  VerificationOutcome,
} from '@oweibo/core-contracts';

interface DeployHealthCheckConfig {
  readonly healthUrl: string;
  readonly expectedStatus?: number;
  readonly expectedJsonBody?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export interface DeployHealthCheckVerifierOptions {
  /** Override fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Default delay before deferred check; default 60. */
  readonly deferredCheckAfterSeconds?: number;
  /** Default request timeout (ms). Default 10_000. */
  readonly timeoutMs?: number;
}

export class DeployHealthCheckVerifier implements IPostExecutionVerifier {
  readonly name = 'deploy_health_check';
  readonly deferredCheckAfterSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(opts: DeployHealthCheckVerifierOptions = {}) {
    this.fetchImpl = opts.fetchImpl
      ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.deferredCheckAfterSeconds = opts.deferredCheckAfterSeconds ?? 60;
    this.defaultTimeoutMs = opts.timeoutMs ?? 10_000;
  }

  appliesTo(actionClass: string): boolean {
    return actionClass.startsWith('deploy.');
  }

  async immediate(input: ImmediateVerifierInput): Promise<VerificationOutcome> {
    const cfg = readConfig((input.adapterOutcome as { verifierConfig?: unknown })?.verifierConfig);
    if (!cfg) return notConfigured();
    return this.runProbe(cfg);
  }

  async deferred(input: DeferredVerifierInput): Promise<VerificationOutcome> {
    const cfg = readConfig(input.verifierConfig);
    if (!cfg) return notConfigured();
    return this.runProbe(cfg);
  }

  private async runProbe(cfg: DeployHealthCheckConfig): Promise<VerificationOutcome> {
    if (!this.fetchImpl) {
      return outcome(3, 'expected', 'no-fetch', { notes: 'no fetch implementation (Node < 18?)' });
    }
    const timeoutMs = cfg.timeoutMs ?? this.defaultTimeoutMs;
    const expectedStatus = cfg.expectedStatus ?? 200;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(cfg.healthUrl, { method: 'GET', signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      return outcome(3, expectedStatus, 'unreachable', { notes: describeError(err) });
    }
    clearTimeout(timer);

    if (res.status !== expectedStatus) {
      return outcome(3, expectedStatus, res.status, { notes: `status mismatch` });
    }
    if (!cfg.expectedJsonBody) {
      return outcome(0, { status: expectedStatus }, { status: res.status });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return outcome(3, cfg.expectedJsonBody, null, { notes: `body not JSON: ${describeError(err)}` });
    }
    const diff = diffStructural(cfg.expectedJsonBody, body);
    if (diff.length === 0) {
      return outcome(0, cfg.expectedJsonBody, body);
    }
    const severity = anyHealthyFieldDrifted(diff) ? 3 : 2;
    return outcome(severity, cfg.expectedJsonBody, body, { diff, notes: `body mismatch: ${diff.join(', ')}` });
  }
}

function readConfig(raw: unknown): DeployHealthCheckConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as DeployHealthCheckConfig;
  if (typeof cfg.healthUrl !== 'string' || cfg.healthUrl.length === 0) return null;
  return cfg;
}

function notConfigured(): VerificationOutcome {
  return outcome(2, 'config', null, { notes: 'verifier config missing or malformed' });
}

function diffStructural(
  expected: Readonly<Record<string, unknown>>,
  observed: unknown,
): string[] {
  if (!observed || typeof observed !== 'object') {
    return Object.keys(expected).map((k) => `${k}: response not an object`);
  }
  const obs = observed as Record<string, unknown>;
  const diff: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(obs, k)) {
      diff.push(`${k}: missing`);
      continue;
    }
    if (JSON.stringify(obs[k]) !== JSON.stringify(v)) {
      diff.push(`${k}: expected=${JSON.stringify(v)} observed=${JSON.stringify(obs[k])}`);
    }
  }
  return diff;
}

function anyHealthyFieldDrifted(diff: readonly string[]): boolean {
  const re = /^(healthy|ready|status|alive)\b/i;
  return diff.some((d) => re.test(d));
}

function outcome(
  severity: DriftSeverity,
  expected: unknown,
  observed: unknown,
  extras: { notes?: string; diff?: unknown } = {},
): VerificationOutcome {
  return {
    severity,
    expected,
    observed,
    ...(extras.diff !== undefined ? { diff: extras.diff } : {}),
    ...(extras.notes !== undefined ? { notes: extras.notes } : {}),
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
