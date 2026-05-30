/**
 * F.5.9 (ttv-finals): HttpMemoryWriter adapter.
 *
 * Implements ISeedMemoryWriter by POSTing to the core-engine internal
 * memory-seed endpoint. Batches into N=20 per call per plan §F.5.9
 * ("Edge: bulk write timeout -> batch into N=20 per call; retry batch
 * on transient failure").
 *
 * Idempotency on the server side: the endpoint checks each seed's
 * tag `seed:<seedId>` and skips already-present entries. This adapter
 * trusts that filtering and returns the writer's response verbatim.
 *
 * Retries: each batch retries up to 2 times on network error / 5xx
 * with exponential backoff (250ms, 750ms). After exhausting retries
 * the batch's seedIds go into `failed` and the next batch proceeds —
 * partial-failure tolerance per plan §F.5 shared edge cases.
 */
import type { SeedMemoryRequest } from './JsonSeedCatalogProvider.js';

export interface SeedMemoryWriteResult {
  readonly inserted: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}

export interface HttpMemoryWriterOptions {
  readonly apiBaseUrl: string;
  /** Bearer token for internal-only auth. Required. */
  readonly internalToken: string;
  /** Batch size; defaults to 20. */
  readonly batchSize?: number;
  /** Per-request timeout, ms. Defaults to 30s. */
  readonly requestTimeoutMs?: number;
  /** Test seam — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface BatchResponse {
  inserted?: string[];
  skipped?: string[];
  failed?: string[];
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [250, 750] as const;

export class HttpMemoryWriter {
  private readonly apiBaseUrl: string;
  private readonly internalToken: string;
  private readonly batchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpMemoryWriterOptions) {
    if (!opts.apiBaseUrl) throw new Error('HttpMemoryWriter: apiBaseUrl required');
    if (!opts.internalToken) throw new Error('HttpMemoryWriter: internalToken required');
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.internalToken = opts.internalToken;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async writeSeeds(tenantId: string, seeds: readonly SeedMemoryRequest[]): Promise<SeedMemoryWriteResult> {
    if (seeds.length === 0) return { inserted: [], skipped: [], failed: [] };

    const inserted: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < seeds.length; i += this.batchSize) {
      const batch = seeds.slice(i, i + this.batchSize);
      try {
        const result = await this.postBatchWithRetry(tenantId, batch);
        inserted.push(...(result.inserted ?? []));
        skipped.push(...(result.skipped ?? []));
        failed.push(...(result.failed ?? []));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const s of batch) failed.push(`${s.seedId}: ${msg}`);
      }
    }

    return { inserted, skipped, failed };
  }

  private async postBatchWithRetry(tenantId: string, batch: readonly SeedMemoryRequest[]): Promise<BatchResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      try {
        return await this.postBatch(tenantId, batch);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === RETRY_BACKOFF_MS.length) break;
        await delay(RETRY_BACKOFF_MS[attempt]!);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async postBatch(tenantId: string, batch: readonly SeedMemoryRequest[]): Promise<BatchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const url = `${this.apiBaseUrl}/api/v1/_internal/memories/seed`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type':  'application/json',
          'authorization': `Bearer ${this.internalToken}`,
          'x-tenant-id':   tenantId,
        },
        body: JSON.stringify({ tenantId, seeds: batch }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new HttpStatusError(res.status, `seed POST returned ${res.status}`);
      }
      const json = await res.json() as BatchResponse;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class HttpStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.status >= 500 && err.status < 600;
  }
  // Network-level errors (TypeError from fetch on connection failure,
  // AbortError on timeout) are retryable.
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
