/**
 * SearXNG API Client.
 * Discovery layer for the Active Perception chain.
 * SearXNG (metasearch) finds relevant URLs → Crawl4AI (deep read) extracts full content.
 *
 * Mirrors the Crawl4AI client pattern for architectural consistency.
 *
 * @module services/recovery/searxngClient
 */

const logger = require('../logger');

/**
 * Default configuration — overridable via environment variables.
 */
const DEFAULTS = {
    baseUrl: process.env.SEARXNG_URL || 'http://searxng:8080',
    resultLimit: parseInt(process.env.SEARXNG_RESULT_LIMIT || '5', 10),
    timeout: parseInt(process.env.SEARXNG_TIMEOUT || '10000', 10),
    maxRetries: 3,
    backoffBaseMs: 1000,
    categories: 'general,it',
};

/**
 * SearXNG client for making metasearch queries.
 * Returns structured results suitable for LLM context injection.
 */
class SearXNGClient {
    [key: string]: any;

    /**
     * @paramoptions - Client configuration
     * @param[options.baseUrl] - SearXNG base URL
     * @param[options.resultLimit] - Max results to return
     * @param[options.timeout] - Request timeout in ms
     * @param[options.maxRetries] - Max retry attempts
     * @param[options.backoffBaseMs] - Base delay for exponential backoff
     * @param[options.categories] - Search categories (comma-separated)
     */
    constructor(options = {} as any) {
        this.baseUrl = options.baseUrl || DEFAULTS.baseUrl;
        this.resultLimit = options.resultLimit || DEFAULTS.resultLimit;
        this.timeout = options.timeout || DEFAULTS.timeout;
        this.maxRetries = options.maxRetries || DEFAULTS.maxRetries;
        this.backoffBaseMs = options.backoffBaseMs || DEFAULTS.backoffBaseMs;
        this.categories = options.categories || DEFAULTS.categories;
    }

    /**
     * Perform a metasearch query against SearXNG.
     * Returns structured results with title, url, and snippet.
     *
     * @paramquery - Search query string
     * @param[options] - Per-request overrides
     * @param[options.limit] - Override result limit for this query
     * @param[options.categories] - Override categories for this query
     * @param[options.engines] - Comma-separated engine names to target
     * @returns
     */
    async search(query, options = {} as any) {
        const limit = options.limit || this.resultLimit;
        const categories = options.categories || this.categories;

        const params = new URLSearchParams({
            q: query,
            format: 'json',
            categories,
        });

        if (options.engines) {
            params.set('engines', options.engines);
        }

        const url = `${this.baseUrl}/search?${params.toString()}`;

        logger.info('SearXNG search', { query: query.slice(0, 80), categories, limit });

        let lastError = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const response = await fetch(url, {
                    method: 'GET',
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`SearXNG HTTP ${response.status}: ${response.statusText}`);
                }

                const data = ((await response.json()) as any);

                if (!data.results || !Array.isArray(data.results)) {
                    logger.warn('SearXNG returned unexpected response shape', { keys: Object.keys(data) });
                    return [];
                }

                // Map to unified format and truncate snippets to conserve LLM context
                const results = data.results.slice(0, limit).map(r => ({
                    title: r.title || 'Untitled',
                    url: r.url || '',
                    snippet: (r.content || r.snippet || '').slice(0, 300),
                    engine: r.engine || 'unknown',
                }));

                logger.debug('SearXNG results', { count: results.length, query: query.slice(0, 40) });
                return results;

            } catch (error) {
                lastError = error;
                const isAbort = error.name === 'AbortError';
                const label = isAbort ? 'timeout' : error.message;

                logger.warn(`SearXNG attempt ${attempt}/${this.maxRetries} failed: ${label}`);

                if (attempt < this.maxRetries) {
                    const delay = this.backoffBaseMs * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        logger.error('SearXNG search exhausted all retries', {
            query: query.slice(0, 80),
            error: lastError?.message,
        });
        return [];
    }

    /**
     * Deep search: SearXNG discovery → pick best URL → Crawl4AI extraction.
     * This is the full Active Perception chain (Scout → Scholar).
     *
     * @paramquery - Search query
     * @paramcrawl4aiClient - Instance of Crawl4AIClient
     * @param[options] - Search and crawl options
     * @param[options.deepReadCount] - How many top URLs to deep-read (default: 1)
     * @returns
     */
    async deepSearch(query, crawl4aiClient, options = {} as any) {
        const deepReadCount = options.deepReadCount || 1;

        // Phase 1: Scout — discover relevant URLs
        const searchResults = await this.search(query, options);

        if (searchResults.length === 0) {
            logger.warn('Deep search: SearXNG returned no results, skipping Crawl4AI phase');
            return { searchResults: [], deepContent: [] };
        }

        // Phase 2: Scholar — deep-read the top URL(s) via Crawl4AI
        const topUrls = searchResults.slice(0, deepReadCount).map(r => r.url).filter(Boolean);
        const deepContent = [];

        for (const url of topUrls) {
            logger.info('Deep search: Crawl4AI deep-reading', { url });
            try {
                const crawlResult = await crawl4aiClient.crawl(url);
                deepContent.push({
                    url,
                    content: crawlResult.success ? crawlResult.content : '',
                    success: crawlResult.success,
                    error: crawlResult.error || null,
                });
            } catch (error) {
                logger.error('Deep search: Crawl4AI failed', { url, error: error.message });
                deepContent.push({
                    url,
                    content: '',
                    success: false,
                    error: error.message,
                });
            }
        }

        return { searchResults, deepContent };
    }

    /**
     * Check SearXNG service health.
     * @returns
     */
    async healthCheck() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${this.baseUrl}/`, {
                method: 'GET',
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            return response.ok;
        } catch {
            return false;
        }
    }
}

module.exports = SearXNGClient;

export {};
