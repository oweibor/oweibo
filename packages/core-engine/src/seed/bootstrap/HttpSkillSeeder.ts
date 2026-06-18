/**
 * B.1: HttpSkillSeeder — ISkillSeeder implementation that POSTs to the
 * core-engine internal route `/api/v1/_internal/skills/seed`.
 *
 * Pairs with the F.5.9 HttpMemoryWriter pattern: the worker process can't
 * construct SkillRegistry (it needs ModelRouter+Qdrant+Redis+Vault), so it
 * outsources discover+ensureEmbedded to the server-side route. This adapter
 * is the worker-facing seam.
 *
 * Idempotency: each POST carries a deterministic `Idempotency-Key`
 * (SHA-256 of `tenantId + bundlePath`). A network-level retry collides
 * on the server's idempotency cache rather than re-running discover().
 *
 * Retries: 2 retries on TypeError / AbortError / 5xx with 250ms + 750ms
 * exponential backoff. Non-retryable 4xx surfaces as HttpStatusError --
 * the caller (SeedSkillsStep) records the result in `failed` and the
 * worker honors the retry budget.
 */
import { createHash } from 'node:crypto';
import type { SkillSeedResult } from './PgSkillSeeder.js';

export interface HttpSkillSeederOptions {
  readonly apiBaseUrl: string;
  /** Bearer token for internal-only auth. Required. */
  readonly internalToken: string;
  /** Per-request timeout, ms. Defaults to 60s (skill embedding can be slow). */
  readonly requestTimeoutMs?: number;
  /** Test seam — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface ServerResponse {
  registered?: string[];
  failed?: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_BACKOFF_MS = [250, 750] as const;

export class HttpSkillSeeder {
  private readonly apiBaseUrl: string;
  private readonly internalToken: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpSkillSeederOptions) {
    if (!opts.apiBaseUrl) throw new Error('HttpSkillSeeder: apiBaseUrl required');
    if (!opts.internalToken) throw new Error('HttpSkillSeeder: internalToken required');
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.internalToken = opts.internalToken;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** POST the bundle path to the internal skills route; return the registered/failed split. */
  async seedSkills(tenantId: string, bundlePath: string): Promise<SkillSeedResult> {
    const result = await this.postWithRetry(tenantId, bundlePath);
    return {
      registered: result.registered ?? [],
      failed: result.failed ?? [],
    };
  }

  private async postWithRetry(tenantId: string, bundlePath: string): Promise<ServerResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      try {
        return await this.post(tenantId, bundlePath);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === RETRY_BACKOFF_MS.length) break;
        await delay(RETRY_BACKOFF_MS[attempt]!);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async post(tenantId: string, bundlePath: string): Promise<ServerResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const url = `${this.apiBaseUrl}/api/v1/_internal/skills/seed`;
      const body = JSON.stringify({ tenantId, bundlePath });
      const idempotencyKey = computeIdempotencyKey(tenantId, bundlePath);
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
        throw new HttpStatusError(res.status, `skills seed POST returned ${res.status}`);
      }
      return await res.json() as ServerResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic Idempotency-Key from (tenantId, bundlePath). */
export function computeIdempotencyKey(tenantId: string, bundlePath: string): string {
  return createHash('sha256').update(`${tenantId}\x00${bundlePath}`).digest('hex');
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
