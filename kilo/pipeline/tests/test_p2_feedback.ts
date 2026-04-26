/**
 * Unit tests for P-2: gate feedback wiring.
 * Tests that evaluateSemantic returns passedInvariantIds/failedInvariantIds,
 * and that pipelineMemoryAdapter.reinforce/penalise increment the correct fields.
 */

const assert = require('assert');

// ── Stubs ─────────────────────────────────────────────────────────────────────

const qdrantPayloadUpdates = [];
const qdrantScrollResults  = {};

const qdrantStub = {
    scroll: async (_col, opts) => {
        const key = JSON.stringify(opts.filter);
        const points = qdrantScrollResults[key] || [];
        return { points, next_page_offset: null };
    },
    updatePayload: async (col, id, payload) => {
        qdrantPayloadUpdates.push({ col, id, payload });
    },
    search: async () => [],
    upsert: async () => {},
};

const embeddingsStub = { embed: async () => new Array(384).fill(0.1) };

const ollamaStub = {
    generate: async (prompt) => {
        if (prompt.includes('never expose stack traces')) {
            return { tripped: false, text: 'VIOLATION: stack trace exposed in error handler' };
        }
        return { tripped: false, text: 'NO_VIOLATION' };
    },
};

const loggerStub    = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const metricsStub   = { gateFailureCount: { inc: () => {} } };
const memoryStub    = { retrieveMemory: async () => 'context' };

// Install a single all-covering stub that never recurses
const Module    = require('module');
const _real     = Module._load;
const _allStubs = {
    '../qdrant':         qdrantStub,
    './qdrant':          qdrantStub,
    '../embeddings':     embeddingsStub,
    './embeddings':      embeddingsStub,
    '../ollama/client':  ollamaStub,
    '../logger':         loggerStub,
    './logger':          loggerStub,
    '../metrics':        metricsStub,
    './metrics':         metricsStub,
    './memory':          memoryStub,
    '../config':         { MEMORY_TIMEOUT_MS: 5000 },
};

Module._load = function (request, parent, isMain) {
    if (_allStubs[request]) return _allStubs[request];
    return _real.apply(this, arguments);
};

const invariantSemantic = require('../src/services/gates/invariantSemantic');
const adapter           = require('../src/services/pipelineMemoryAdapter');

Module._load = _real;   // restore

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testSemanticGateReturnsIds() {
    const invariants = [
        { id: 'inv-good-1', rule: 'All API responses must include a request_id header' },
        { id: 'inv-bad-1',  rule: 'never expose stack traces in API responses' },
        { id: 'inv-good-2', rule: 'All database queries must be parameterised' },
    ];

    const result = await invariantSemantic.evaluateSemantic('task-x', invariants, 'diff content');

    assert.ok(!result.passed, 'Gate should fail due to inv-bad-1 violation');
    assert.ok(Array.isArray(result.passedInvariantIds), 'passedInvariantIds should be an array');
    assert.ok(Array.isArray(result.failedInvariantIds), 'failedInvariantIds should be an array');
    assert.ok(result.passedInvariantIds.includes('inv-good-1'), 'inv-good-1 should be in passed list');
    assert.ok(result.passedInvariantIds.includes('inv-good-2'), 'inv-good-2 should be in passed list');
    assert.ok(result.failedInvariantIds.includes('inv-bad-1'),  'inv-bad-1 should be in failed list');
    assert.ok(!result.failedInvariantIds.includes('inv-good-1'), 'inv-good-1 must NOT be in failed list');

    console.log('  ✓ evaluateSemantic returns passedInvariantIds:', result.passedInvariantIds);
    console.log('  ✓ evaluateSemantic returns failedInvariantIds:', result.failedInvariantIds);
}

async function testVacuousPassReturnsEmptyArrays() {
    const result = await invariantSemantic.evaluateSemantic('task-y', [], 'diff');
    assert.deepStrictEqual(result.passedInvariantIds, []);
    assert.deepStrictEqual(result.failedInvariantIds, []);
    console.log('  ✓ Vacuous pass returns empty ID arrays');
}

async function testReinforceIncrementsHitCount() {
    qdrantPayloadUpdates.length = 0;
    const filterKey = JSON.stringify({ must: [{ key: 'id', match: { value: 'inv-123' } }] });
    qdrantScrollResults[filterKey] = [
        { id: 'inv-123', payload: { hit_count: 5, false_positive_count: 1 } },
    ];

    await adapter.reinforce('inv-123', 'tenant-t1');

    assert.strictEqual(qdrantPayloadUpdates.length, 1, 'reinforce should call updatePayload once');
    const update = qdrantPayloadUpdates[0];
    assert.strictEqual(update.id, 'inv-123');
    assert.strictEqual(update.payload.hit_count, 6, 'hit_count should increment to 6');
    assert.ok(!('false_positive_count' in update.payload), 'reinforce must not touch false_positive_count');

    console.log('  ✓ reinforce increments hit_count from 5 → 6');
}

async function testPenaliseIncrementsFalsePositiveCount() {
    qdrantPayloadUpdates.length = 0;
    const filterKey = JSON.stringify({ must: [{ key: 'id', match: { value: 'inv-456' } }] });
    qdrantScrollResults[filterKey] = [
        { id: 'inv-456', payload: { hit_count: 3, false_positive_count: 2 } },
    ];

    await adapter.penalise('inv-456', 'tenant-t1');

    assert.strictEqual(qdrantPayloadUpdates.length, 1, 'penalise should call updatePayload once');
    const update = qdrantPayloadUpdates[0];
    assert.strictEqual(update.id, 'inv-456');
    assert.strictEqual(update.payload.false_positive_count, 3, 'false_positive_count should increment to 3');
    assert.ok(!('hit_count' in update.payload), 'penalise must not touch hit_count');

    console.log('  ✓ penalise increments false_positive_count from 2 → 3');
}

async function testReinforceNullIdIsNoOp() {
    qdrantPayloadUpdates.length = 0;
    await adapter.reinforce(null, 'tenant-t1');
    assert.strictEqual(qdrantPayloadUpdates.length, 0, 'null pointId should be a no-op');
    console.log('  ✓ reinforce(null) is a no-op');
}

async function run() {
    console.log('\n=== P-2: gate feedback tests ===');
    try {
        await testSemanticGateReturnsIds();
        await testVacuousPassReturnsEmptyArrays();
        await testReinforceIncrementsHitCount();
        await testPenaliseIncrementsFalsePositiveCount();
        await testReinforceNullIdIsNoOp();
        console.log('P-2 feedback tests: ALL PASSED\n');
    } catch (err) {
        console.error('P-2 feedback test FAILED:', err.message);
        process.exit(1);
    }
}

run();

export {};
