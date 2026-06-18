/**
 * B.2: HttpDomainClassifier — IIntakeClassifier implementation that POSTs to
 * `/api/v1/_internal/domain/classify`.
 *
 * The worker keeps the Postgres state machine (claim/complete/fail rows)
 * local in PgDomainIntakeProcessor; only the embedding+classification step
 * is outsourced via this adapter. Server side has the DomainClassifier
 * (which needs an embedder + ontology); worker has the row state.
 *
 * Idempotency: each POST carries a deterministic `Idempotency-Key`
 * (SHA-256 of `tenantId + JSON(input)`). A network-level retry collides
 * on the server's idempotency cache rather than re-running classification.
 *
 * Retries: 2 retries on TypeError / AbortError / 5xx with 250ms + 750ms
 * exponential backoff. Non-retryable 4xx surfaces as HttpStatusError --
 * the caller (PgDomainIntakeProcessor) records the failure and the worker
 * honors the retry budget.
 */
import { createHash } from 'node:crypto';
import type { IIntakeClassifier, IntakeProcessResult } from './PgDomainIntakeProcessor.js';
import type { IntakeInput } from '../DomainIntakeService.js';

export interface HttpDomainClassifierOptions {
  readonly apiBaseUrl: string;
  /** Bearer token for internal-only auth. Required. */
  readonly internalToken: string;
  /** Per-request timeout, ms. Defaults to 30s. */
  readonly requestTimeoutMs?: number;
  /** Test seam — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface ServerResponse {
  classifiedDomain: string | null;
  classifiedConfidence: number | null;
  recommendedTemplate: string | null;
  recommendedConnectors: string[];
  recommendedSeedSkills: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [250, 750] as const;

export class HttpDomainClassifier implements IIntakeClassifier {
  private readonly apiBaseUrl: string;
  private readonly internalToken: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpDomainClassifierOptions) {
    if (!opts.apiBaseUrl) throw new Error('HttpDomainClassifier: apiBaseUrl required');
    if (!opts.internalToken) throw new Error('HttpDomainClassifier: internalToken required');
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.internalToken = opts.internalToken;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async classify(tenantId: string, input: IntakeInput): Promise<IntakeProcessResult> {
    const result = await this.postWithRetry(tenantId, input);
    return {
      classifiedDomain: result.classifiedDomain,
      classifiedConfidence: result.classifiedConfidence,
      recommendedTemplate: result.recommendedTemplate,
      recommendedConnectors: result.recommendedConnectors ?? [],
      recommendedSeedSkills: result.recommendedSeedSkills ?? [],
    };
  }

  private async postWithRetry(tenantId: string, input: IntakeInput): Promise<ServerResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      try {
        return await this.post(tenantId, input);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === RETRY_BACKOFF_MS.length) break;
        await delay(RETRY_BACKOFF_MS[attempt]!);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async post(tenantId: string, input: IntakeInput): Promise<ServerResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const url = `${this.apiBaseUrl}/api/v1/_internal/domain/classify`;
      const body = JSON.stringify({ tenantId, ...input });
      const idempotencyKey = computeIdempotencyKey(tenantId, body);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type':    'application/json',
          'authorization':   `Bearer ${this.internalToken}`,
          'x-tenant-id':     tenantId,
          'idempotency-key': idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new HttpStatusError(res.status, `domain classify POST returned ${res.status}`);
      }
      return await res.json() as ServerResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic Idempotency-Key from (tenantId, serialized input). */
export function computeIdempotencyKey(tenantId: string, body: string): string {
  return createHash('sha256').update(`${tenantId}\x00${body}`).digest('hex');
}

export class HttpStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status >= 500 && err.status < 600;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
