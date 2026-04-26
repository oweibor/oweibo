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
export declare class DocFetcher {
    private readonly redisGet;
    private readonly redisSetEx;
    constructor(redisGet: (key: string) => Promise<string | null>, redisSetEx: (key: string, ttl: number, value: string) => Promise<void>);
    /**
     * fetchRaw — fetches raw content from a URL.
     * Caches by URL (+ relevant headers) in Redis unless ttl=0.
     * Throws on HTTP 4xx/5xx or network errors.
     */
    fetchRaw(url: string, opts?: FetchRawOptions): Promise<FetchRawResult>;
    private httpGet;
}
//# sourceMappingURL=DocFetcher.d.ts.map