/**
 * Unit tests for P-5: pipeline stage STM writes.
 * Tests that storeStageOutput writes to Qdrant project_history and
 * recallStageContext can retrieve results by semantic search.
 */

const assert = require('assert');

// ── Stubs ─────────────────────────────────────────────────────────────────────

const upsertedPoints   = [];
const searchedQueries  = [];

const qdrantStub = {
    upsert: async (col, points) => {
        upsertedPoints.push({ col, points });
    },
    search: async (col, vector, topK, threshold, filter) => {
        searchedQueries.push({ col, topK, threshold, filter });
        // Return a fake hit
        return [
            {
                score: 0.88,
                payload: {
                    tenant_id: filter.must[1].match.value,
                    task_id:   filter.must[0].match.value.replace('pipeline:', ''),
                    stage:     'architect',
                    summary:   'Architecture plan generated',
                },
            },
        ];
    },
};

const embeddingsStub = { embed: async (text) => new Array(384).fill(0.1) };

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === './qdrant')      return qdrantStub;
    if (request === './embeddings')  return embeddingsStub;
    if (request === './memory')      return { retrieveMemory: async () => 'ctx' };
    if (request === './logger')      return { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    if (request === 'uuid')          return require('uuid');
    return _origLoad.apply(this, arguments);
};

const adapter = require('../src/services/pipelineMemoryAdapter');
Module._load = _origLoad;

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testStoreStageOutputWritesToProjectHistory() {
    upsertedPoints.length = 0;

    await adapter.storeStageOutput({
        tenantId: 'tenant-abc',
        taskId:   'task-999',
        stage:    'architect',
        summary:  'Architecture plan generated: add auth middleware to all routes',
        detail:   { planLength: 1234, exitCode: 0 },
    });

    assert.strictEqual(upsertedPoints.length, 1, 'storeStageOutput should upsert 1 point');
    const call = upsertedPoints[0];
    assert.strictEqual(call.col, 'project_history', 'Stage output must go to project_history');

    const payload = call.points[0].payload;
    assert.strictEqual(payload.tenant_id, 'tenant-abc');
    assert.strictEqual(payload.task_id,   'task-999');
    assert.strictEqual(payload.stage,     'architect');
    assert.strictEqual(payload.scope,     'pipeline:task-999');
    assert.ok(payload.created_at, 'created_at should be set');

    console.log('  ✓ storeStageOutput writes to project_history with correct scope and metadata');
}

async function testRecallStageContextSearchesHistory() {
    searchedQueries.length = 0;

    const results = await adapter.recallStageContext({
        tenantId: 'tenant-abc',
        taskId:   'task-999',
        query:    'authentication middleware routing decisions',
        topK:     3,
    });

    assert.strictEqual(searchedQueries.length, 1, 'recallStageContext should call qdrant.search once');
    const q = searchedQueries[0];
    assert.strictEqual(q.col,   'project_history', 'Search should target project_history');
    assert.strictEqual(q.topK,  3);
    assert.ok(q.threshold >= 0, 'Should have a minimum score threshold');

    // Verify filter contains both scope and tenant_id
    const scopeClause = q.filter.must.find(c => c.key === 'scope');
    const tenantClause = q.filter.must.find(c => c.key === 'tenant_id');
    assert.ok(scopeClause,  'Filter must include scope');
    assert.ok(tenantClause, 'Filter must include tenant_id');
    assert.strictEqual(scopeClause.match.value, 'pipeline:task-999');
    assert.strictEqual(tenantClause.match.value, 'tenant-abc');

    assert.strictEqual(results.length, 1, 'Should return the mocked result');
    assert.ok(results[0].score > 0, 'Result should have a score');

    console.log('  ✓ recallStageContext searches project_history with correct filters');
}

async function testStoreStageOutputNonFatalOnMissingFields() {
    upsertedPoints.length = 0;
    // Missing tenantId should be a no-op (non-fatal)
    await adapter.storeStageOutput({ taskId: 'x', stage: 'test', summary: 's', detail: {} });
    assert.strictEqual(upsertedPoints.length, 0, 'Missing tenantId should be a no-op');
    console.log('  ✓ storeStageOutput is a no-op when tenantId is missing');
}

async function run() {
    console.log('\n=== P-5: pipeline stage STM write tests ===');
    try {
        await testStoreStageOutputWritesToProjectHistory();
        await testRecallStageContextSearchesHistory();
        await testStoreStageOutputNonFatalOnMissingFields();
        console.log('P-5 stage write tests: ALL PASSED\n');
    } catch (err) {
        console.error('P-5 stage write test FAILED:', err.message);
        process.exit(1);
    }
}

run();

export {};
