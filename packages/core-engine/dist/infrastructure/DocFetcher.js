"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocFetcher = void 0;
/**
 * DocFetcher — handles HTTP GET requests with Redis caching.
 * Concrete implementation in main.ts wires the actual Redis client and HTTP layer.
 */
class DocFetcher {
    redisGet;
    redisSetEx;
    constructor(redisGet, redisSetEx) {
        this.redisGet = redisGet;
        this.redisSetEx = redisSetEx;
    }
    /**
     * fetchRaw — fetches raw content from a URL.
     * Caches by URL (+ relevant headers) in Redis unless ttl=0.
     * Throws on HTTP 4xx/5xx or network errors.
     */
    async fetchRaw(url, opts = {}) {
        const { extraHeaders = {}, ttl = 300 } = opts;
        const cacheKey = `docfetcher:${url}`;
        if (ttl > 0) {
            const cached = await this.redisGet(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
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
    async httpGet(url, headers) {
        const https = await import('https');
        const http = await import('http');
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? https : http;
            const options = { headers: { 'User-Agent': 'oweibo/1.0', ...headers } };
            const req = lib.get(url, options, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        content: Buffer.concat(chunks).toString('utf8'),
                        etag: res.headers.etag,
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
exports.DocFetcher = DocFetcher;
//# sourceMappingURL=DocFetcher.js.map