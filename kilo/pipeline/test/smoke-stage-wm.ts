/**
 * Smoke test for stage-level WorkingMemory adoption (P-7).
 *
 * Verifies that:
 *   1. pipelineMemoryAdapter.getWorkingMemory returns a typed bucket
 *   2. Distinct (tenant, task) pairs get distinct buckets
 *   3. releaseWorkingMemory clears + removes the bucket so re-acquiring
 *      yields a fresh one
 *   4. Stage-style writes (stages.architect / stages.orchestrate / stages.gates)
 *      round-trip through wm.set / wm.get
 *   5. Refusing anonymous scopes (no tenant or no task) throws, NOT silently
 *      shares a bucket — the correctness hazard the registry guards against
 *
 * Runs WITHOUT spinning up qdrant, embeddings, or sandbox: it talks directly
 * to the WorkingMemoryRegistry that pipelineMemoryAdapter already wraps.
 *
 * Usage:  node test/smoke-stage-wm.js
 * Exit:   0 = all assertions passed, 1 = any failure
 */

const assert = require('assert');
const { WorkingMemoryRegistry } = require('@oweibo/core-engine');

const passed = [];
const failed = [];

function check(label, fn) {
    try {
        fn();
        passed.push(label);
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failed.push({ label, message: err.message });
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

console.log('Stage-level WorkingMemory smoke test');
console.log('====================================');

// We use the registry directly rather than going through pipelineMemoryAdapter
// because that module pulls in kilo's config which requires KILO_API_TOKEN /
// TENANT_TOKENS to be set in the environment. The adapter's getWorkingMemory
// is just a thin wrapper around `registry.for({tenantId, taskId})`, so testing
// the registry directly covers the same surface.
const registry = new WorkingMemoryRegistry();

// 1. Bucket shape
check('returns a typed bucket with set / get / has / delete / snapshot', () => {
    const wm = registry.for({ tenantId: 't1', taskId: 'task-A' });
    assert.strictEqual(typeof wm.set, 'function');
    assert.strictEqual(typeof wm.get, 'function');
    assert.strictEqual(typeof wm.has, 'function');
    assert.strictEqual(typeof wm.delete, 'function');
    assert.strictEqual(typeof wm.snapshot, 'function');
});

// 2. Round-trip stage-shaped writes
check('round-trips stages.architect payload', () => {
    const wm = registry.for({ tenantId: 't1', taskId: 'task-A' });
    const arch = { plan: '# Plan\n…', exitCode: 0, planLength: 10, completedAt: '2026-04-19T00:00:00Z' };
    wm.set('stages.architect', arch);
    assert.deepStrictEqual(wm.get('stages.architect'), arch);
});

check('round-trips stages.orchestrate payload', () => {
    const wm = registry.for({ tenantId: 't1', taskId: 'task-A' });
    const orch = {
        exitCode: 0,
        route: 'gates',
        changedFiles: { 'src/foo.js': 'modified' },
        changedFileCount: 1,
        completedAt: '2026-04-19T00:00:01Z',
    };
    wm.set('stages.orchestrate', orch);
    assert.deepStrictEqual(wm.get('stages.orchestrate'), orch);
});

check('round-trips stages.gates payload', () => {
    const wm = registry.for({ tenantId: 't1', taskId: 'task-A' });
    const gates = {
        outcome: 'PASSED',
        passedInvariantIds: ['inv-1', 'inv-2'],
        adrPassed: true,
        contextMatchPassed: true,
        completedAt: '2026-04-19T00:00:02Z',
    };
    wm.set('stages.gates', gates);
    assert.deepStrictEqual(wm.get('stages.gates'), gates);
});

check('snapshot reflects all stage writes', () => {
    const wm = registry.for({ tenantId: 't1', taskId: 'task-A' });
    const snap = wm.snapshot();
    assert.ok(snap['stages.architect'],    'snapshot missing stages.architect');
    assert.ok(snap['stages.orchestrate'],  'snapshot missing stages.orchestrate');
    assert.ok(snap['stages.gates'],        'snapshot missing stages.gates');
});

// 3. Bucket isolation by (tenant, task)
check('different (tenant, task) get different buckets', () => {
    const a = registry.for({ tenantId: 't1', taskId: 'task-A' });
    const b = registry.for({ tenantId: 't1', taskId: 'task-B' });
    assert.notStrictEqual(a, b, 'expected distinct bucket instances');
    assert.strictEqual(b.get('stages.architect'), undefined,
        'task-B should not see task-A writes');
});

check('different tenants with same taskId are isolated', () => {
    const a = registry.for({ tenantId: 't1', taskId: 'shared' });
    const b = registry.for({ tenantId: 't2', taskId: 'shared' });
    a.set('marker', 'tenant-1');
    b.set('marker', 'tenant-2');
    assert.strictEqual(a.get('marker'), 'tenant-1');
    assert.strictEqual(b.get('marker'), 'tenant-2');
});

// 4. Same (tenant, task) returns the same bucket (within a task lifecycle)
check('repeated for() with same scope returns same bucket', () => {
    const a = registry.for({ tenantId: 't1', taskId: 'task-A' });
    const b = registry.for({ tenantId: 't1', taskId: 'task-A' });
    assert.strictEqual(a, b, 'expected identical bucket instance');
});

// 5. release() clears state and yields a fresh bucket on re-acquire
check('release() clears bucket; re-acquire is empty', () => {
    const before = registry.for({ tenantId: 't1', taskId: 'task-A' });
    assert.ok(before.has('stages.architect'), 'precondition: bucket should be populated');
    registry.release({ tenantId: 't1', taskId: 'task-A' });
    const after = registry.for({ tenantId: 't1', taskId: 'task-A' });
    assert.strictEqual(after.has('stages.architect'), false,
        'expected re-acquired bucket to be empty');
});

// 6. Refuse anonymous scopes — silent collisions are the bug we guard against
check('throws when scope has neither taskId nor sessionId', () => {
    assert.throws(
        () => registry.for({ tenantId: 't1' }),
        /must include taskId or sessionId/,
    );
});

// 7. Cross-stage read pattern: a "later stage" can pull what an earlier wrote.
//    This is the actual win of the wm refactor — gate code does not need the
//    orchestrate result threaded through opts.
check('cross-stage read: gate can pull orchestrate.changedFiles from wm', () => {
    registry.release({ tenantId: 't1', taskId: 'task-X' });
    const wm = registry.for({ tenantId: 't1', taskId: 'task-X' });

    // Simulate orchestrate stage writing
    wm.set('stages.orchestrate', {
        exitCode: 0,
        route: 'gates',
        changedFiles: { 'a.js': 'modified', 'b.js': 'added' },
        changedFileCount: 2,
        completedAt: new Date().toISOString(),
    });

    // Simulate a gate later pulling it without it being threaded through args
    const orch = wm.get('stages.orchestrate');
    assert.strictEqual(orch.changedFileCount, 2);
    assert.deepStrictEqual(Object.keys(orch.changedFiles).sort(), ['a.js', 'b.js']);
});

console.log('====================================');
console.log(`Passed: ${passed.length}    Failed: ${failed.length}`);
if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.label}: ${f.message}`);
    process.exit(1);
}
process.exit(0);

export {};
