/**
 * Memory retrieval module.
 * Parallel search across all 5 Qdrant collections with per-collection
 * thresholds and tenant isolation via payload filtering.
 *
 * Every vector stored in Qdrant must carry a `tenant_id` field in its
 * payload.  Searches automatically filter to the calling task's tenant so
 * cross-tenant data leakage is impossible at the query layer.
 *
 * @module services/memory
 */

const config     = require('../config');
const qdrant     = require('./qdrant');
const embeddings = require('./embeddings');
const logger     = require('./logger');

/**
 * Collection search configuration.
 * threshold, limit, and optional filter/transform/truncate per collection.
 */
const COLLECTION_CONFIG = {
    project_decisions: {
        threshold: 0.65,
        limit: 5,
        filter: (results) =>
            results.filter((r) => !r.payload?.source_path?.includes('staging/')),
    },
    project_invariants: {
        // Only retrieve active (promoted) invariants; staging entries are pre-filtered
        // by payload field status:'active'.  threshold:0 is intentional — all active
        // invariants are relevant regardless of cosine score.
        threshold: 0,
        limit: 100,
        filter: (results) => results.filter((r) => r.payload?.status === 'active'),
    },
    project_reasoning: {
        threshold: 0.70,
        limit: 5,
        transform: (results) =>
            results.map((r) => ({
                ...r,
                score:   r.score,
                payload: {
                    ...r.payload,
                    // Apply -0.10 confidence penalty for reasoning entries
                    confidence: Math.max(0, (r.payload?.confidence || r.score) - 0.10),
                },
            })),
    },
    project_history: {
        threshold: 0.65,
        limit: 3,
        filter: null,
    },
    // project_context retired (P-3): entries migrated to project_history as
    // tier:'semantic' scope:'tenant:{tenantId}' via oweibo memory export-invariants.
    // The flat limit:50 / threshold:0 dump that consumed the entire context window
    // on qwen2.5-coder:1.5b is eliminated.  Run LtmMigrationService.runMigration2to3()
    // to move any existing project_context data before removing the collection.
};

/**
 * Build a Qdrant filter that restricts results to a single tenant.
 *
 * @paramtenantId
 * @returnsQdrant filter condition
 */
function tenantFilter(tenantId) {
    return {
        must: [
            {
                key:   'tenant_id',
                match: { value: tenantId },
            },
        ],
    };
}

/**
 * Estimate token count from text (rough: 1 token ≈ 4 chars).
 * @paramtext
 * @returns
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/**
 * Retrieve memory context for a task, scoped to the task's tenant.
 *
 * @paramtaskId    - Current task ID (for logging)
 * @paraminstruction - Task instruction text
 * @paramtenantId  - Tenant scope for vector isolation
 * @returnsFormatted MEMORY CONTEXT BLOCK
 */
async function retrieveMemory(taskId, instruction, tenantId) {
    if (!tenantId) {
        throw new Error('retrieveMemory requires a tenantId for tenant isolation');
    }

    const startMs = Date.now();
    logger.info('Memory retrieval started', { task_id: taskId, tenant_id: tenantId });

    // Generate embedding for the instruction
    const queryVector = await embeddings.embed(instruction);

    // Build per-tenant Qdrant filter
    const filter = tenantFilter(tenantId);

    // Search all collections in parallel with timeout
    const searchPromises = Object.entries(COLLECTION_CONFIG).map(
        async ([collection, cfg]) => {
            try {
                let results = await qdrant.search(
                    collection,
                    queryVector,
                    cfg.limit,
                    cfg.threshold || undefined,
                    filter           // ← tenant isolation filter
                );

                if ((cfg as any).filter)    results = (cfg as any).filter(results);
                if ((cfg as any).transform) results = (cfg as any).transform(results);

                return { collection, results, error: null };
            } catch (err) {
                logger.warn('Memory search failed for collection', {
                    collection,
                    tenant_id: tenantId,
                    error: err.message,
                });
                return { collection, results: [], error: err.message };
            }
        }
    );

    const timeoutPromise = new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error('Memory retrieval timeout')), config.MEMORY_TIMEOUT_MS)
    );

    /** @type*/
    let searchResults;
    try {
        searchResults = await Promise.race([Promise.all(searchPromises), timeoutPromise]);
    } catch (err) {
        logger.error('Memory retrieval timed out', {
            task_id:    taskId,
            tenant_id:  tenantId,
            timeout_ms: config.MEMORY_TIMEOUT_MS,
        });
        searchResults = [];
    }

    const block = formatMemoryBlock(searchResults);

    logger.info('Memory retrieval complete', {
        task_id:       taskId,
        tenant_id:     tenantId,
        duration_ms:   Date.now() - startMs,
        sections:      searchResults.length,
        total_results: searchResults.reduce((sum, s) => sum + s.results.length, 0),
    });

    return block;
}

/**
 * Format search results into a structured memory context block.
 *
 * @paramsearchResults
 * @returns
 */
function formatMemoryBlock(searchResults) {
    const sections = [];

    sections.push('=== MEMORY CONTEXT BLOCK ===');
    sections.push(`Retrieved at: ${new Date().toISOString()}`);
    sections.push('');

    for (const { collection, results, error } of searchResults) {
        const heading = collection.replace('project_', '').toUpperCase();
        sections.push(`--- ${heading} (${results.length} results) ---`);

        if (error) {
            sections.push(`  [ERROR: ${error}]`);
            sections.push('');
            continue;
        }

        if (results.length === 0) {
            sections.push('  (no relevant entries)');
            sections.push('');
            continue;
        }

        const cfg = COLLECTION_CONFIG[collection];
        let content = '';

        for (const result of results) {
            const score      = result.score?.toFixed(3) || '—';
            const title      = result.payload?.title || result.payload?.source_path || result.id;
            const text       = result.payload?.content || result.payload?.text || '';
            const confidence = result.payload?.confidence;

            let entry = `  [${score}] ${title}`;
            if (confidence !== undefined) entry += ` (confidence: ${confidence.toFixed(2)})`;
            entry += `\n    ${text.slice(0, 500)}`;
            content += entry + '\n';
        }

        if (cfg?.truncate && estimateTokens(content) > cfg.truncate) {
            const maxChars = cfg.truncate * 4;
            content = content.slice(0, maxChars) + '\n    [TRUNCATED — exceeded token cap]';
        }

        sections.push(content);
        sections.push('');
    }

    sections.push('=== END MEMORY CONTEXT BLOCK ===');
    return sections.join('\n');
}

module.exports = { retrieveMemory };

export {};
