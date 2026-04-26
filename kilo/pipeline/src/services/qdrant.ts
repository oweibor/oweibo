/**
 * Qdrant vector database client with retry logic.
 * Wraps @qdrant/js-client-rest with exponential backoff.
 *
 * @module services/qdrant
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../config');
const logger = require('./logger');
const { CircuitBreaker } = require('./llm/CircuitBreaker');

// Circuit breaker for Qdrant — mirrors the pattern used by LLM provider clients.
// Trips after 5 consecutive failures; half-opens after 30 s with exponential backoff.
const _breaker = new CircuitBreaker({
    windowSize:       10,
    failureThreshold: 0.5,   // trip when ≥50% of the last 10 calls failed
    resetTimeoutMs:   30_000, // 30 s before first probe attempt
});

/** @type*/
let client;

/**
 * Initialize the Qdrant client.
 * Parses QDRANT_HOST URL to extract host and port.
 */
function initialize() {
    const url = new URL(config.QDRANT_HOST);
    client = new QdrantClient({
        host: url.hostname,
        port: parseInt(url.port, 10) || 6333,
        // Per-request timeout shorter than global MEMORY_TIMEOUT_MS so stalled
        // HTTP connections are aborted at the transport layer, not left dangling.
        timeout: Math.floor(config.MEMORY_TIMEOUT_MS / 3),
    });
    logger.info('Qdrant client initialized', { host: config.QDRANT_HOST });
}

/**
 * Retry wrapper with exponential backoff.
 * @paramfn - Async function to retry
 * @paramretries - Max retries (default 3)
 * @parambaseDelayMs - Initial delay (default 500ms)
 * @returns
 */
async function withRetry(fn, retries = 3, baseDelayMs = 500) {
    if (!_breaker.isCallAllowed()) {
        const err: any = new Error('Qdrant circuit breaker is OPEN — operation rejected');
        err.code = 'QDRANT_CIRCUIT_OPEN';
        throw err;
    }

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const result = await fn();
            _breaker.recordSuccess();
            return result;
        } catch (err: any) {
            // Do not penalise the breaker for circuit-open self-rejections
            if (err.code !== 'QDRANT_CIRCUIT_OPEN') {
                _breaker.recordFailure();
            }
            lastError = err;
            if (attempt < retries) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                logger.warn('Qdrant operation failed, retrying', {
                    attempt: attempt + 1,
                    delay_ms: delay,
                    error: err.message,
                });
                await new Promise<any>((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

/**
 * Search a collection for similar vectors.
 *
 * @paramcollection - Collection name
 * @paramvector - Query vector (384-dim)
 * @paramlimit - Max results
 * @param[scoreThreshold] - Minimum similarity score
 * @param[filter] - Qdrant filter conditions
 * @returns
 */
async function search(collection, vector, limit, scoreThreshold, filter) {
    return withRetry(async () => {
        const searchParams: any = {
            vector: Array.from(vector),
            limit,
            with_payload: true,
        };
        if (scoreThreshold !== undefined) {
            searchParams.score_threshold = scoreThreshold;
        }
        if (filter) {
            searchParams.filter = filter;
        }
        const result = await client.search(collection, searchParams);
        return result;
    });
}

/**
 * Upsert points into a collection.
 *
 * @paramcollection - Collection name
 * @parampoints
 * @returns
 */
async function upsert(collection, points) {
    return withRetry(async () => {
        await client.upsert(collection, {
            wait: true,
            points: points.map((p) => ({
                id: p.id,
                vector: Array.from(p.vector),
                payload: p.payload,
            })),
        });
        logger.debug('Qdrant upsert complete', {
            collection,
            count: points.length,
        });
    });
}

/**
 * Check if Qdrant is healthy.
 * @returns
 */
async function isHealthy() {
    try {
        await client.getCollections();
        return true;
    } catch {
        return false;
    }
}

/**
 * List all collections.
 * @returns
 */
async function listCollections() {
    const result = await client.getCollections();
    return result.collections.map((c) => c.name);
}

/**
 * Get collection info.
 * @paramcollection - Collection name
 * @returns
 */
async function getCollection(collection) {
    return withRetry(async () => {
        return await client.getCollection(collection);
    });
}

/**
 * Create a collection.
 * @paramcollection - Collection name
 * @paramparams - Collection parameters
 * @returns
 */
async function createCollection(collection, params) {
    return withRetry(async () => {
        await client.createCollection(collection, {
            vectors: params.vectors || { size: params.vectorSize || 384, distance: 'Cosine' },
            ...params,
        });
        logger.debug('Qdrant collection created', { collection });
    });
}

/**
 * Create a payload index.
 * @paramcollection - Collection name
 * @paramfield - Field name
 * @paramfieldType - Field type (keyword, integer, etc.)
 * @returns
 */
async function createIndex(collection, field, fieldType) {
    return withRetry(async () => {
        await client.createPayloadIndex(collection, {
            field_name: field,
            field_type: fieldType,
        });
        logger.debug('Qdrant index created', { collection, field, fieldType });
    });
}

/**
 * Scroll through collection points.
 * @paramcollection - Collection name
 * @paramoptions - Scroll options (filter, limit, with_payload)
 * @returns
 */
async function scroll(collection, options = {} as any) {
    return withRetry(async () => {
        const result = await client.scroll(collection, {
            with_payload: options.with_payload !== false,
            limit: options.limit || 100,
            filter: options.filter,
        });
        return result;
    });
}

/**
 * Delete points from a collection.
 * @paramcollection - Collection name
 * @paramoptions - Delete options (filter)
 * @returns
 */
async function deletePoints(collection, options = {} as any) {
    return withRetry(async () => {
        const result = await client.delete(collection, {
            wait: true,
            filter: options.filter,
        });
        logger.debug('Qdrant points deleted', { collection, deleted: result.deleted });
        return { deleted: result.deleted || 0 };
    });
}

/**
 * Update (merge) payload fields on existing points without replacing the vector.
 * Uses Qdrant's setPayload which does a shallow merge, not an overwrite.
 *
 * @paramcollection - Collection name
 * @paramid - Point ID
 * @parampayload - Fields to merge into the existing payload
 * @returns
 */
async function updatePayload(collection, id, payload) {
    return withRetry(async () => {
        await client.setPayload(collection, {
            payload,
            points: [id],
            wait: true,
        });
        logger.debug('Qdrant payload updated', { collection, id });
    });
}

/**
 * Return the underlying @qdrant/js-client-rest QdrantClient instance.
 * Exposed so consumers needing operations not wrapped here (e.g. setPayload
 * with multiple ids, batch upsert variants) can drive the client directly.
 *
 * @returns
 * @throwsIf initialize() has not been called.
 */
function getClient() {
    if (!client) {
        throw new Error('Qdrant client not initialized. Call initialize() first.');
    }
    return client;
}

/** Return the current state of the Qdrant circuit breaker ('CLOSED'|'OPEN'|'HALF_OPEN'). */
function getBreakerState() {
    return _breaker.getState();
}

module.exports = {
    initialize,
    search,
    upsert,
    updatePayload,
    isHealthy,
    listCollections,
    getCollection,
    createCollection,
    createIndex,
    scroll,
    delete: deletePoints,
    getClient,
    getBreakerState,
};

export {};
