/**
 * PipelineMemoryAdapter (P-6).
 *
 * Drop-in replacement for services/memory.js that adds gate feedback
 * (reinforce / penalise), pipeline stage writes (storeStageOutput), and
 * stage-context recall — all missing from the original direct Qdrant calls.
 *
 * Wraps the existing qdrant.js and embeddings.js services so the pipeline keeps
 * working without a compiled packages/core-engine TypeScript build.  When
 * core-engine is available it can be swapped in here behind the same interface.
 *
 * All public methods are non-fatal: failures are logged and swallowed so that
 * memory errors never halt the task pipeline.
 *
 * @module services/pipelineMemoryAdapter
 */

const memory     = require('./memory');
const qdrant     = require('./qdrant');
const embeddings = require('./embeddings');
const logger     = require('./logger');

// ── WorkingMemory tier (from @oweibo/core-engine) ──────────────────────────────
//
// Wires the new 4-tier contract's tier-1 (per-task in-process scratchpad) into
// the pipeline. Replaces the ad-hoc untyped-context-bag pattern stages currently
// use to share state.
//
// Only the WorkingMemory tier is wired here. STM (tier 2) and ProjectRegistry
// (tier 3) need Redis, which kilo/pipeline does not currently provision; the
// SemanticMemoryAdapter (tier 4) needs the legacy LongTermMemoryStore wired up.
// Those tiers stay deferred until the storage-model reconciliation in phase B.
const { WorkingMemoryRegistry, KiloSemanticAdapter } = require('@oweibo/core-engine');

/** Process-wide singleton — one bucket per (tenantId, taskId). */
const workingMemoryRegistry = new WorkingMemoryRegistry();

// ── Semantic-tier singleton (lazy) ─────────────────────────────────────────────
//
// Built on first access so that test envs that don't initialize qdrant or
// embeddings can still load this module without throwing.  Reuses kilo's
// existing qdrant client (raw @qdrant/js-client-rest) and embeddings service.
//
// The adapter exposes the contract's ISemanticMemoryStore — store / recall /
// purgeTenant / purgeProject — over kilo's project_decisions, project_reasoning,
// and project_history collections.  project_invariants is intentionally NOT
// touched: those are gate rules with their own promotion/decay machinery.

/** @type*/
let semanticStore = null;

function getSemanticStore() {
    if (semanticStore) return semanticStore;
    const qdrantClient = qdrant.getClient();
    semanticStore = new KiloSemanticAdapter({
        qdrant:   qdrantClient,
        // embed() returns a Float32Array; the adapter contract wants number[].
        embedder: async (text) => Array.from(await embeddings.embed(text)),
    });
    return semanticStore;
}

/**
 * Acquire (or get the existing) per-task WorkingMemory scratchpad. Stages
 * that need to share typed state across stage boundaries should pull this
 * via memoryAdapter.getWorkingMemory(...) and call .set/.get on it instead
 * of mutating an untyped opts/context bag.
 *
 * @paramtenantId
 * @paramtaskId
 * @returns
 */
function getWorkingMemory(tenantId, taskId) {
    if (!tenantId || !taskId) {
        throw new Error('getWorkingMemory: both tenantId and taskId are required');
    }
    return workingMemoryRegistry.for({ tenantId, taskId });
}

/**
 * Release a task's WorkingMemory bucket so its entries can be GC'd. Must be
 * called at task lifecycle end (success OR failure) — without this, every
 * completed task leaks its scratchpad for the lifetime of the process.
 *
 * @paramtenantId
 * @paramtaskId
 * @returns
 */
function releaseWorkingMemory(tenantId, taskId) {
    if (!tenantId || !taskId) return;
    workingMemoryRegistry.release({ tenantId, taskId });
}

// ── Retrieve memory context ────────────────────────────────────────────────────

/**
 * Drop-in replacement for memory.retrieveMemory().
 * Returns the same formatted MEMORY CONTEXT BLOCK string.
 *
 * @paramtaskId
 * @paraminstruction
 * @paramtenantId
 * @returns
 */
async function retrieveMemory(taskId, instruction, tenantId) {
    return memory.retrieveMemory(taskId, instruction, tenantId);
}

// ── Gate feedback ──────────────────────────────────────────────────────────────

/**
 * Record that an invariant was useful: the gate fired, the task was clean.
 * Increments hit_count and updates last_used_at in Qdrant.
 *
 * @parampointId   - Qdrant point ID of the invariant
 * @param_tenantId - Retained for future tenant-scoped collections
 * @returns
 */
async function reinforce(pointId, _tenantId) {
    if (!pointId) return;
    try {
        // Read current hit_count first so the increment is accurate even under
        // concurrent updates (best-effort; not a transaction).
        const filter = { must: [{ key: 'id', match: { value: pointId } }] };
        const result = await qdrant.scroll('project_invariants', {
            with_payload: true, limit: 1, filter,
        });
        const current = result.points.length > 0 ? (result.points[0].payload?.hit_count || 0) : 0;

        await qdrant.updatePayload('project_invariants', pointId, {
            hit_count: current + 1,
            last_used_at: new Date().toISOString(),
        });
        logger.debug('PipelineMemoryAdapter: reinforced invariant', { pointId });
    } catch (err) {
        logger.warn('PipelineMemoryAdapter: reinforce failed (non-fatal)', {
            pointId, error: err.message,
        });
    }
}

/**
 * Record that an invariant produced a false positive: it blocked a task that
 * a human later approved.  Increments false_positive_count in Qdrant.
 *
 * @parampointId
 * @param_tenantId
 * @returns
 */
async function penalise(pointId, _tenantId) {
    if (!pointId) return;
    try {
        const filter = { must: [{ key: 'id', match: { value: pointId } }] };
        const result = await qdrant.scroll('project_invariants', {
            with_payload: true, limit: 1, filter,
        });
        const current = result.points.length > 0
            ? (result.points[0].payload?.false_positive_count || 0)
            : 0;

        await qdrant.updatePayload('project_invariants', pointId, {
            false_positive_count: current + 1,
            last_used_at: new Date().toISOString(),
        });
        logger.info('PipelineMemoryAdapter: penalised invariant (false positive recorded)', { pointId });
    } catch (err) {
        logger.warn('PipelineMemoryAdapter: penalise failed (non-fatal)', {
            pointId, error: err.message,
        });
    }
}

// ── Pipeline stage STM writes ──────────────────────────────────────────────────

/**
 * Write a stage boundary summary to the project_history Qdrant collection.
 * Downstream stages and subsequent tasks can recall these via recallStageContext().
 *
 * Non-fatal: a write failure never stalls the pipeline.
 *
 * @paramopts
 * @paramopts.tenantId
 * @paramopts.taskId
 * @paramopts.stage      - Stage name e.g. 'architect', 'orchestrate', 'gate-8b'
 * @paramopts.summary    - Short human-readable summary (used as vector source)
 * @param[opts.detail]   - Optional structured payload
 * @returns
 */
async function storeStageOutput({ tenantId, taskId, stage, summary, detail }) {
    if (!tenantId || !taskId || !summary) return;
    try {
        const { v4: uuidv4 } = require('uuid');
        const id = uuidv4();
        const vector = await embeddings.embed(summary);
        const payload = {
            tenant_id:  tenantId,
            task_id:    taskId,
            scope:      `pipeline:${taskId}`,
            stage,
            summary:    summary.slice(0, 500),
            detail:     detail || {},
            created_at: new Date().toISOString(),
        };
        await qdrant.upsert('project_history', [{ id, vector, payload }]);
        logger.debug('PipelineMemoryAdapter: stage output stored', { taskId, stage });
    } catch (err) {
        logger.warn('PipelineMemoryAdapter: storeStageOutput failed (non-fatal)', {
            taskId, stage, error: err.message,
        });
    }
}

/**
 * Semantically recall prior stage outputs for a task.
 * Returns an array of matching history entries sorted by relevance score.
 *
 * @paramopts
 * @paramopts.tenantId
 * @paramopts.taskId
 * @paramopts.query    - Natural language query
 * @param[opts.topK=5]
 * @returns
 */
async function recallStageContext({ tenantId, taskId, query, topK = 5 }) {
    if (!tenantId || !taskId || !query) return [];
    try {
        const vector = await embeddings.embed(query);
        const filter = {
            must: [
                { key: 'scope',     match: { value: `pipeline:${taskId}` } },
                { key: 'tenant_id', match: { value: tenantId } },
            ],
        };
        const results = await qdrant.search('project_history', vector, topK, 0.35, filter);
        return results.map(r => ({ score: r.score, payload: r.payload }));
    } catch (err) {
        logger.warn('PipelineMemoryAdapter: recallStageContext failed (non-fatal)', {
            taskId, error: err.message,
        });
        return [];
    }
}

/**
 * Called at task end to flush any pending state.
 * Currently a no-op; placeholder for future STM → LTM consolidation.
 *
 * @param_tenantId
 * @param_taskId
 * @returns
 */
async function finalizeTask(_tenantId, _taskId) {
    // Future: compress stage STM entries into an LTM episodic write.
}

module.exports = {
    retrieveMemory,
    reinforce,
    penalise,
    storeStageOutput,
    recallStageContext,
    finalizeTask,
    getWorkingMemory,
    releaseWorkingMemory,
    getSemanticStore,
};

export {};
