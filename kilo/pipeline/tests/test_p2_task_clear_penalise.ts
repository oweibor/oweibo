/**
 * Test that POST /task/clear correctly penalises gate-failed invariants.
 * This is the actual human-override path: when supervised mode blocks a task
 * due to a gate failure, the human calls /task/clear to unblock it, and
 * penalise() must fire on the blocking invariants.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// Pre-load before stub so we don't recurse
const uuidMod = require('uuid');

// ── Stubs ─────────────────────────────────────────────────────────────────────

const penalisedIds  = [];
const qdrantUpdates = [];

const qdrantStub = {
    scroll: async (_col, opts) => {
        const key = JSON.stringify(opts.filter);
        if (key.includes('inv-gate-fail')) {
            return { points: [{ id: 'inv-gate-fail', payload: { false_positive_count: 1 } }], next_page_offset: null };
        }
        return { points: [], next_page_offset: null };
    },
    updatePayload: async (_col, id, payload) => {
        qdrantUpdates.push({ id, payload });
        penalisedIds.push(id);
    },
};

// In-process stub for pipelineMemoryAdapter that calls our qdrantStub directly
const adapterStub = {
    retrieveMemory: async () => '',
    reinforce: async () => {},
    penalise: async (pointId, _tenantId) => {
        if (!pointId) return;
        const filter = { must: [{ key: 'id', match: { value: pointId } }] };
        const result = await qdrantStub.scroll('project_invariants', { filter });
        const current = result.points.length > 0
            ? (result.points[0].payload?.false_positive_count || 0) : 0;
        await qdrantStub.updatePayload('project_invariants', pointId, { false_positive_count: current + 1, last_used_at: new Date().toISOString() });
    },
    storeStageOutput: async () => {},
    recallStageContext: async () => [],
    finalizeTask: async () => {},
};

const loggerStub = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

// Set up a temp dir with a gate_results.json
const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-test-'));
const taskDir = path.join(tmpDir, 'tenant-sup', 'blocked-task-001');
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, 'gate_results.json'), JSON.stringify({
    task_id: 'blocked-task-001',
    passed_invariant_ids: ['inv-good-1'],
    failed_invariant_ids: ['inv-gate-fail'],
    written_at: new Date().toISOString(),
}, null, 2));

const configStub = {
    CHECKPOINT_DIR: tmpDir,
    WORKSPACE_ROOT: tmpDir,
    TRUST_MODE: 'supervised',
    KILO_API_TOKEN: 'test-token',
};

const queueStub = {
    get: () => ({ task_id: 'blocked-task-001', tenant_id: 'tenant-sup', status: 'blocked' }),
    clearBlock: () => true,
    update: () => {},
};

// Install a single all-covering stub — keep it active for the whole test
const Module = require('module');
const _real  = Module._load;
const _stubs = {
    '../services/qdrant':                qdrantStub,
    './qdrant':                          qdrantStub,
    '../qdrant':                         qdrantStub,
    '../services/pipelineMemoryAdapter': adapterStub,
    './pipelineMemoryAdapter':           adapterStub,
    '../services/memory':                { retrieveMemory: async () => '' },
    './memory':                          { retrieveMemory: async () => '' },
    '../services/logger':                loggerStub,
    './logger':                          loggerStub,
    '../logger':                         loggerStub,
    '../config':                         configStub,
    './config':                          configStub,
    '../../config':                      configStub,
    '../services/queue':                 queueStub,
    '../middleware/auth':                (req, res, next) => { req.tenantId = 'tenant-sup'; next(); },
    '../services/recovery/ledger':       { getLedgerEntry: () => ({}), saveLedgerEntry: () => {}, resetLedger: () => true, evaluateWall: () => false },
    'uuid':                              uuidMod,
};

Module._load = function (request, parent, isMain) {
    if (_stubs[request]) return _stubs[request];
    return _real.apply(this, arguments);
};

const taskRouter = require('../src/routes/task');

// NOTE: stub stays active so the lazy require inside _penaliseGateFailedInvariants
// is intercepted when it runs during the async test.

// ── Mini express harness ──────────────────────────────────────────────────────

async function simulateRequest(router, method, url, body): Promise<any> {
    return new Promise<any>((resolve) => {
        const req = {
            method:   method.toUpperCase(),
            path:     url,
            url,
            body,
            tenantId: 'tenant-sup',
            params:   {},
        };
        const res = {
            _status: 200,
            status(s) { this._status = s; return this; },
            json(b)   { resolve({ status: this._status, body: b }); },
        };

        const layers = (router.stack || []).filter(l => l.route);
        for (const layer of layers) {
            if (layer.route.path === url && layer.route.methods[method.toLowerCase()]) {
                const handlers = layer.route.stack.map(s => s.handle);
                let i = 0;
                const next = () => { if (i < handlers.length) handlers[i++](req, res, next); };
                next();
                return;
            }
        }
        resolve({ status: 404, body: { error: 'route not found' } });
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testLegacyClearPenalisesGateFailedInvariants() {
    penalisedIds.length  = 0;
    qdrantUpdates.length = 0;

    const resp = await simulateRequest(taskRouter, 'POST', '/task/clear', {
        task_id: 'blocked-task-001',
    });

    assert.strictEqual(resp.status, 200,
        `Expected 200, got ${resp.status}: ${JSON.stringify(resp.body)}`);

    // Give the fire-and-forget penalise a tick to complete
    await new Promise(r => setTimeout(r, 100));

    assert.ok(penalisedIds.includes('inv-gate-fail'),
        `inv-gate-fail must be penalised on legacy task/clear. Got: ${JSON.stringify(penalisedIds)}`);

    const fpUpdate = qdrantUpdates.find(u => u.id === 'inv-gate-fail');
    assert.ok(fpUpdate, 'updatePayload should be called for inv-gate-fail');
    assert.strictEqual(fpUpdate.payload.false_positive_count, 2,
        'false_positive_count should increment from 1 → 2');

    console.log('  ✓ POST /task/clear (legacy) penalises blocking invariants');
    console.log('  ✓ false_positive_count incremented 1 → 2');
}

async function testProvideGuidancePenalisesGateFailedInvariants() {
    penalisedIds.length  = 0;
    qdrantUpdates.length = 0;

    const resp = await simulateRequest(taskRouter, 'POST', '/task/clear', {
        task_id: 'blocked-task-001',
        action:  'provide_guidance',
        guidance: 'Skip this check — known false positive on legacy code',
    });

    assert.strictEqual(resp.status, 200, `Expected 200, got ${resp.status}`);

    await new Promise(r => setTimeout(r, 100));

    assert.ok(penalisedIds.includes('inv-gate-fail'),
        `inv-gate-fail must be penalised on provide_guidance override`);
    console.log('  ✓ POST /task/clear (provide_guidance) penalises blocking invariants');
}

async function run() {
    console.log('\n=== P-2 (fix): task/clear penalise path ===');
    try {
        await testLegacyClearPenalisesGateFailedInvariants();
        await testProvideGuidancePenalisesGateFailedInvariants();
        console.log('P-2 task/clear penalise tests: ALL PASSED\n');
    } catch (err) {
        console.error('P-2 task/clear penalise test FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        Module._load = _real;  // restore after all tests
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

run();

export {};
