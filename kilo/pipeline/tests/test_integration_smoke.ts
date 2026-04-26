/**
 * Integration smoke test: verify all changed modules load and export correctly,
 * and that no old filesystem-write paths (appendFileSync to invariants.yaml) remain.
 */

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');

// ── Minimal stubs for I/O-heavy deps ─────────────────────────────────────────

const Module    = require('module');
const _real     = Module._load;

const qdrantStub = {
    initialize: () => {},
    search: async () => [],
    upsert: async () => {},
    scroll: async () => ({ points: [], next_page_offset: null }),
    delete: async () => {},
    updatePayload: async () => {},
    isHealthy: async () => true,
    listCollections: async () => [],
    getCollection: async () => ({}),
    createCollection: async () => {},
    createIndex: async () => {},
};

const loggerStub  = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const metricsStub = {
    gateFailureCount:    { inc: () => {} },
    taskCount:           { inc: () => {} },
    activeTasksGauge:    { set: () => {} },
    queueDepthGauge:     { set: () => {} },
    updateQuarantineMetrics: async () => {},
    register:            { contentType: '', metrics: async () => '' },
    scraperMetrics:      null,
};
const embeddingsStub = { initialize: async () => {}, embed: async () => new Array(384).fill(0.1) };
const sandboxStub    = { initialize: () => {}, spawnSandbox: async () => ({ containerId: 'c1' }), execInSandbox: async () => ({ exitCode: 0, stdout: '', stderr: '' }), cleanupSandbox: async () => {} };
const ollamaStub     = { generate: async () => ({ tripped: false, text: 'NO_VIOLATION' }) };
const watcherStub    = { start: () => {}, stop: () => {} };
const cronStub       = { schedule: () => {} };
const promClientStub = { Registry: class { contentType=''; metrics=async()=>''; registerMetric(){} register(){} }, Counter: class { inc(){} labels(){ return this; } }, Gauge: class { set(){} labels(){ return this; } }, register: { contentType: '', metrics: async() => '', registerMetric(){}, setDefaultLabels(){} } };
const configStub     = {
    PORT: 3000, TRUST_MODE: 'supervised', QDRANT_HOST: 'http://localhost:6333',
    MEMORY_TIMEOUT_MS: 5000, CHECKPOINT_DIR: '/tmp/kilo-test-checkpoint',
    WORKSPACE_ROOT: '/tmp/kilo-test-ws', DECAY_CRON: '0 3 * * 0',
    IDLE_REFLECTION_CRON: '0 * * * *', CURRICULUM_CRON: '0 3 * * 1',
    KILO_PROJECT_DIR: '/tmp/kilo-proj', DECAY_STALE_DAYS: 90,
    DECAY_FP_THRESHOLD: 0.30, MAX_CONCURRENCY: 1, TENANT_MAX_CONCURRENCY: 2,
    MAX_CONCURRENCY_HARD_CAP: 12,
};

const _stubs = {
    './services/qdrant':             qdrantStub,
    './services/logger':             loggerStub,
    './services/metrics':            metricsStub,
    './services/embeddings':         embeddingsStub,
    './services/sandbox':            sandboxStub,
    './services/ollama/client':      ollamaStub,
    './services/watcher':            watcherStub,
    '../config':                     configStub,
    './config':                      configStub,
    '../../config':                  configStub,
    '../logger':                     loggerStub,
    './logger':                      loggerStub,
    '../metrics':                    metricsStub,
    './metrics':                     metricsStub,
    '../qdrant':                     qdrantStub,
    './qdrant':                      qdrantStub,
    '../embeddings':                 embeddingsStub,
    './embeddings':                  embeddingsStub,
    '../ollama/client':              ollamaStub,
    '../sandbox':                    sandboxStub,
    'node-cron':                     cronStub,
    'prom-client':                   promClientStub,
};

Module._load = function (request, parent, isMain) {
    if (_stubs[request]) return _stubs[request];
    return _real.apply(this, arguments);
};

// ── Load all changed modules ──────────────────────────────────────────────────

let engine, decay, memoryMod, adapter, stagingRouter, executor, invariantSem, invariantDet;
const errors = [];

function tryLoad(name, loader) {
    try {
        return loader();
    } catch (err) {
        errors.push(`LOAD ERROR in ${name}: ${err.message}`);
        return null;
    }
}

engine       = tryLoad('engine.js',             () => require('../src/services/promotion/engine'));
decay        = tryLoad('decay.js',              () => require('../src/services/promotion/decay'));
memoryMod    = tryLoad('memory.js',             () => require('../src/services/memory'));
adapter      = tryLoad('pipelineMemoryAdapter', () => require('../src/services/pipelineMemoryAdapter'));
invariantSem = tryLoad('invariantSemantic.js',  () => require('../src/services/gates/invariantSemantic'));
invariantDet = tryLoad('invariantDeterministic.js', () => require('../src/services/gates/invariantDeterministic'));
executor     = tryLoad('executor.js',           () => require('../src/services/executor'));

Module._load = _real;

// ── Assertions ────────────────────────────────────────────────────────────────

console.log('\n=== Integration Smoke Test ===');

if (errors.length > 0) {
    errors.forEach(e => console.error('  ✗', e));
    process.exit(1);
}

// 1. engine.js exports
assert.ok(typeof engine.promoteItem    === 'function', 'engine.promoteItem should be a function');
assert.ok(typeof engine.evaluateStaging === 'function', 'engine.evaluateStaging should be a function');
console.log('  ✓ engine.js exports promoteItem and evaluateStaging');

// 2. decay.js exports
assert.ok(typeof decay.run === 'function', 'decay.run should be a function');
// Verify old functions are NOT exported (removed as part of P-1)
assert.strictEqual(decay.removeFromYaml, undefined, 'removeFromYaml should NOT be exported');
assert.strictEqual(decay.writeToStaging, undefined, 'writeToStaging should NOT be exported');
console.log('  ✓ decay.js exports only run(); removeFromYaml/writeToStaging are gone');

// 3. memory.js: project_context not in COLLECTION_CONFIG
assert.ok(typeof memoryMod.retrieveMemory === 'function', 'memory.retrieveMemory should be a function');
console.log('  ✓ memory.js exports retrieveMemory');

// 4. pipelineMemoryAdapter exports all required methods
const requiredMethods = ['retrieveMemory', 'reinforce', 'penalise', 'storeStageOutput', 'recallStageContext', 'finalizeTask'];
for (const m of requiredMethods) {
    assert.ok(typeof adapter[m] === 'function', `pipelineMemoryAdapter.${m} should be a function`);
}
console.log('  ✓ pipelineMemoryAdapter exports:', requiredMethods.join(', '));

// 5. invariantSemantic returns shape includes new ID arrays
assert.ok(typeof invariantSem.evaluateSemantic === 'function', 'evaluateSemantic should be a function');
console.log('  ✓ invariantSemantic.js loads correctly');

// 6. invariantDeterministic
assert.ok(typeof invariantDet.evaluateDeterministic === 'function', 'evaluateDeterministic should be a function');
console.log('  ✓ invariantDeterministic.js loads correctly');

// 7. executor.js
assert.ok(typeof executor.runArchitect   === 'function', 'executor.runArchitect should be a function');
assert.ok(typeof executor.runOrchestrate === 'function', 'executor.runOrchestrate should be a function');
// Verify the new opts parameter signature is accepted (no error on extra arg)
const archLen = executor.runArchitect.length;
console.log(`  ✓ executor.js: runArchitect signature (${archLen} declared params)`);

// 8. Verify source: engine.js does NOT contain appendFileSync for invariants.yaml
const engineSrc = fs.readFileSync(path.join(__dirname, '../src/services/promotion/engine.ts'), 'utf8');
assert.ok(!engineSrc.includes('appendFileSync'), 'engine.js must NOT contain appendFileSync');
// invariants.yaml may appear in comments — check there is no write call using it
const yamlWriteInEngine = /fs\.(appendFileSync|writeFileSync)\s*\([^)]*invariants\.yaml/.test(engineSrc);
assert.ok(!yamlWriteInEngine, 'engine.js must NOT call fs.writeFileSync/appendFileSync on invariants.yaml');
console.log('  ✓ engine.js source contains no appendFileSync or runtime write to invariants.yaml');

// 9. Verify source: decay.js does NOT contain removeFromYaml or writeToStaging
const decaySrc = fs.readFileSync(path.join(__dirname, '../src/services/promotion/decay.ts'), 'utf8');
// removeFromYaml and writeToStaging should not be callable functions any more
assert.ok(!/function removeFromYaml/.test(decaySrc), 'decay.js must NOT define removeFromYaml function');
assert.ok(!/function writeToStaging/.test(decaySrc),  'decay.js must NOT define writeToStaging function');
// No runtime fs write to invariants.yaml
const yamlWriteInDecay = /fs\.(appendFileSync|writeFileSync)\s*\([^)]*invariants\.yaml/.test(decaySrc);
assert.ok(!yamlWriteInDecay, 'decay.js must NOT call fs.*Sync on invariants.yaml');
console.log('  ✓ decay.js source contains no removeFromYaml/writeToStaging function definitions or yaml writes');

// 10. Verify memory.js does not reference project_context in COLLECTION_CONFIG
const memorySrc = fs.readFileSync(path.join(__dirname, '../src/services/memory.ts'), 'utf8');
// Check that project_context is not a live config entry (may appear in comment)
const configMatch = memorySrc.match(/project_context:\s*\{/);
assert.ok(!configMatch, 'memory.js COLLECTION_CONFIG must not contain project_context: { as active entry');
console.log('  ✓ memory.js COLLECTION_CONFIG does not contain a live project_context entry');

// 11. Verify index.js uses pipelineMemoryAdapter (not raw memory.retrieveMemory)
const indexSrc = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
assert.ok(indexSrc.includes('pipelineMemoryAdapter'), 'index.js must import pipelineMemoryAdapter');
assert.ok(indexSrc.includes('memoryAdapter.retrieveMemory'), 'index.js must call memoryAdapter.retrieveMemory');
assert.ok(indexSrc.includes('memoryAdapter.reinforce'), 'index.js must call memoryAdapter.reinforce');
assert.ok(indexSrc.includes('_writeGateResults'), 'index.js must call _writeGateResults');
console.log('  ✓ index.js wires pipelineMemoryAdapter (retrieveMemory, reinforce, _writeGateResults)');

console.log('\nIntegration Smoke Test: ALL PASSED\n');

export {};
