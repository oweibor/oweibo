/**
 * DocFetcher — Redis-cached HTTP fetcher for third-party docs and raw content (G10).
 *
 * Used by:
 *   - GeneralCodingOrchestrator to fetch library changelogs when the agent detects version uncertainty
 *   - RemoteSkillFetcher for HTTPS-sourced skills (via fetchRaw)
 *
 * All HTTP in core-engine routes through this class — no direct https.get() elsewhere.
 */
export interface FetchRawOptions {
  extraHeaders?: Record<string, string>;
  /** Cache TTL in seconds. Pass 0 to bypass cache (always fetch fresh). */
  ttl?: number;
}

export interface FetchRawResult {
  content: string;
  /** ETag header value if the server sent one; undefined otherwise. */
  etag?: string;
  /** HTTP status code. */
  statusCode: number;
}

/**
 * DocFetcher — handles HTTP GET requests with Redis caching.
 * Concrete implementation in main.ts wires the actual Redis client and HTTP layer.
 */
export class DocFetcher {
  constructor(
    private readonly redisGet: (key: string) => Promise<string | null>,
    private readonly redisSetEx: (key: string, ttl: number, value: string) => Promise<void>,
  ) {}

  /**
   * fetchRaw — fetches raw content from a URL.
   * Caches by URL (+ relevant headers) in Redis unless ttl=0.
   * Throws on HTTP 4xx/5xx or network errors.
   */
  async fetchRaw(url: string, opts: FetchRawOptions = {}): Promise<FetchRawResult> {
    const { extraHeaders = {}, ttl = 300 } = opts;
    const cacheKey = `docfetcher:${url}`;

    if (ttl > 0) {
      const cached = await this.redisGet(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as FetchRawResult;
        return parsed;
      }
    }

    // Dynamic import of node:https to keep this module edge-compatible
    const result = await this.httpGet(url, extraHeaders);

    if (ttl > 0 && result.statusCode >= 200 && result.statusCode < 300) {
      await this.redisSetEx(cacheKey, ttl, JSON.stringify(result));
    }

    if (result.statusCode >= 400) {
      throw new Error(`DocFetcher: HTTP ${result.statusCode} from ${url}`);
    }

    return result;
  }

  private async httpGet(
    url: string,
    headers: Record<string, string>,
  ): Promise<FetchRawResult> {
    const https = await import('https');
    const http  = await import('http');

    return new Promise((resolve, reject) => {
      const lib      = url.startsWith('https') ? https : http;
      const options  = { headers: { 'User-Agent': 'oweibo/1.0', ...headers } };

      const req = lib.get(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            content:    Buffer.concat(chunks).toString('utf8'),
            etag:       res.headers.etag as string | undefined,
            statusCode: res.statusCode ?? 0,
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`DocFetcher: request to ${url} timed out after 30s`));
      });
    });
  }
}
