/**
 * Stage 3a: Search Router.
 * Determines if a COMPLEX error needs RAG, Web Search, or both.
 * Routes web search through SearXNG (discovery) with optional Crawl4AI deep-read.
 *
 * Active Perception Chain:
 *   SearXNG (Scout) → finds relevant URLs
 *   Crawl4AI (Scholar) → deep-reads top URL for full context
 *
 * @module services/recovery/searchRouter
 */

const logger = require('../logger');
const SearXNGClient = require('./searxngClient');
const Crawl4AIClient = require('../scraper/crawl4ai/client');

// Singleton instances — reused across recovery cycles
const searxng = new SearXNGClient();
const crawl4ai = new Crawl4AIClient();

/**
 * Default RAG score thresholds per technology stack category.
 * A score above the threshold implies confidence in RAG alone.
 * Below 0.50 implies RAG is useless and Web Search ONLY should be used.
 * In between implies RAG + Web Search combo.
 */
const RAG_THRESHOLDS = {
    flutter: 0.80,
    postgresql: 0.75,
    nextjs: 0.72,
    langchain: 0.70,
    celery: 0.68,
    bullmq: 0.65,
    timeout_cpu: 0.85,
    timeout_net: 0.70,
    timeout_inst: 0.60,
    default: 0.75,
};

/**
 * Detect the likely stack category from the error trace.
 * @paramcanonicalKey 
 * @returns
 */
function detectStackCategory(canonicalKey) {
    const key = canonicalKey.toLowerCase();
    for (const stack of Object.keys(RAG_THRESHOLDS)) {
        if (key.includes(stack)) return stack;
    }
    return 'default';
}

/**
 * Stubbed RAG search. (Will be fully implemented with Qdrant vector retrieval.)
 * @paramquery 
 * @returns
 */
async function performRagSearch(query) {
    logger.debug('RAG search invoked (stubbed)', { query });
    return []; // Pending Qdrant RAG integration
}

/**
 * Web search via SearXNG metasearch engine.
 * Returns structured results with title, url, and snippet.
 *
 * @paramquery 
 * @returns
 */
async function performWebSearch(query) {
    return searxng.search(query);
}

/**
 * Deep web search: SearXNG discovery → Crawl4AI deep-read of top result.
 * Used when RAG confidence is very low and the agent needs full page context.
 *
 * @paramquery
 * @returns
 */
async function performDeepSearch(query) {
    return searxng.deepSearch(query, crawl4ai, { deepReadCount: 1 });
}

/**
 * Route the search based on error context and thresholds.
 *
 * Strategy selection:
 *   RAG_ONLY     — high confidence in local knowledge (score >= threshold)
 *   RAG_AND_WEB  — moderate confidence; supplement RAG with SearXNG snippets
 *   WEB_DEEP     — low confidence; full Scout→Scholar perception chain
 *
 * @paramcanonicalError 
 * @paramsyntheticRagScore - RAG confidence score (0.0–1.0)
 * @returns
 */
async function routeSearch(canonicalError, syntheticRagScore = 0.60) {
    const category = detectStackCategory(canonicalError.canonical_key);
    const threshold = RAG_THRESHOLDS[category] || RAG_THRESHOLDS.default;

    const query = `${canonicalError.error_type} ${canonicalError.calling_function}`;

    let strategy = '';
    let rag_results = [];
    let web_results = [];
    let deep_content = [];

    logger.info('Routing search for COMPLEX error', { category, threshold, syntheticRagScore });

    if (syntheticRagScore >= threshold) {
        // High confidence — local knowledge is sufficient
        strategy = 'RAG_ONLY';
        rag_results = await performRagSearch(query);

    } else if (syntheticRagScore >= 0.50) {
        // Moderate confidence — supplement RAG with SearXNG snippets
        strategy = 'RAG_AND_WEB';
        [rag_results, web_results] = await Promise.all([
            performRagSearch(query),
            performWebSearch(query)
        ]);

    } else {
        // Low confidence — full perception chain: SearXNG → Crawl4AI deep read
        strategy = 'WEB_DEEP';
        const deepResult = await performDeepSearch(query);
        web_results = deepResult.searchResults;
        deep_content = deepResult.deepContent;
    }

    return {
        strategy,
        rag_results,
        web_results,
        deep_content,
    };
}

module.exports = {
    routeSearch,
    performWebSearch,
    performDeepSearch,
    RAG_THRESHOLDS,
    detectStackCategory,
};

export {};
