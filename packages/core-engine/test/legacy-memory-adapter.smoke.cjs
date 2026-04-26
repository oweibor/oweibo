'use strict';

/**
 * Smoke test for LegacyMemorySystemAdapter (the deprecation shim).
 *
 * Verifies that the adapter:
 *   1. Translates legacy `store()` input shape into the orchestrator's
 *      StoreMemoryInput, mapping legacy MemoryType to contract MemoryKind
 *      and threading scope fields into MemoryScope.
 *   2. Smuggles relevanceTags through detail.tags so SemanticMemoryAdapter
 *      can lift them back into LTM relevanceTags on the way to disk.
 *   3. Returns the orchestrator's recorded entry id from store().
 *   4. Translates legacy `recall()` query into assembleContext input,
 *      converts each RankedMemoryEntry back into the legacy RecallResult
 *      shape (legacy MemoryEntry fields, ms timestamps, single-string scope).
 *   5. Filters by minScore on the way out.
 *   6. endSession() invokes the optional teardown hook and never throws.
 *   7. endSession() swallows hook errors.
 *   8. reinforceMemory / penaliseMemory are non-throwing no-ops.
 *
 * Uses an in-memory mock IMemoryOrchestrator — no Redis, no Qdrant.
 */

const assert = require('node:assert');
const { LegacyMemorySystemAdapter } = require('../dist/index.js');

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

async function checkAsync(label, fn) {
    try {
        await fn();
        passed.push(label);
        console.log(`  ✓ ${label}`);
    } catch (err) {
        failed.push({ label, message: err.message });
        console.log(`  ✗ ${label}\n      ${err.message}`);
    }
}

console.log('LegacyMemorySystemAdapter smoke test');
console.log('====================================');

// ── Mock orchestrator ──────────────────────────────────────────────────────

function createMockOrchestrator() {
    const recordCalls = [];
    const assembleCalls = [];

    return {
        recordCalls,
        assembleCalls,
        working() { throw new Error('not used in this test'); },
        async record(input) {
            recordCalls.push(input);
            return {
                id:          'recorded-id-' + recordCalls.length,
                scope:       input.scope,
                kind:        input.kind,
                summary:     input.summary,
                body:        input.body,
                detail:      input.detail,
                importance:  input.importance,
                createdAt:   '2026-04-19T00:00:00.000Z',
                updatedAt:   '2026-04-19T00:00:00.000Z',
                recallCount: 0,
            };
        },
        async assembleContext(input) {
            assembleCalls.push(input);
            const ranked = [
                {
                    id:          'rm-1',
                    scope:       { tenantId: input.scope.tenantId, sessionId: input.scope.sessionId },
                    kind:        'success-pattern',
                    summary:     'first match',
                    body:        undefined,
                    detail:      { tags: ['general-coding', 'edit'] },
                    importance:  0.75,
                    createdAt:   '2026-04-18T12:00:00.000Z',
                    updatedAt:   '2026-04-19T00:00:00.000Z',
                    recallCount: 3,
                    score:       0.85,
                    scoreBreakdown: { semantic: 0.85, recency: 0, importance: 0, kindBoost: 0, mmrPenalty: 0 },
                },
                {
                    id:          'rm-2',
                    scope:       { tenantId: input.scope.tenantId },
                    kind:        'failure-lesson',
                    summary:     'second match',
                    body:        'long-form rationale',
                    detail:      undefined,
                    importance:  0.5,
                    createdAt:   '2026-04-17T00:00:00.000Z',
                    updatedAt:   '2026-04-17T00:00:00.000Z',
                    recallCount: 1,
                    score:       0.40,
                    scoreBreakdown: { semantic: 0.40, recency: 0, importance: 0, kindBoost: 0, mmrPenalty: 0 },
                },
            ];
            return {
                scope:           input.scope,
                project:         null,
                session:         null,
                rankedMemories:  ranked,
                promptBlock:     '',
                estimatedTokens: 0,
            };
        },
        async recordTurn() { /* not used here */ },
        async consolidate() { return []; },
    };
}

// ── 1. store() translation ──────────────────────────────────────────────────

let orch = createMockOrchestrator();
let adapter = new LegacyMemorySystemAdapter({ orchestrator: orch });

(async () => {
    let storedId;
    await checkAsync('store() returns the orchestrator-recorded id', async () => {
        storedId = await adapter.store({
            tenantId:      'tenant-A',
            userId:        'user-X',
            sessionId:     'sess-1',
            projectId:     'proj-Q',
            scope:         'session:sess-1',
            type:          'successful-strategy',
            tier:          'episodic',
            summary:       'edited foo.ts and bar.ts — verification passed',
            detail:        { commitHash: 'abc123', editedFiles: ['foo.ts', 'bar.ts'] },
            relevanceTags: ['general-coding', 'edit'],
        });
        assert.strictEqual(storedId, 'recorded-id-1');
    });

    check('store() called orchestrator.record() once', () => {
        assert.strictEqual(orch.recordCalls.length, 1);
    });

    check('store() translated legacy MemoryType to contract MemoryKind', () => {
        assert.strictEqual(orch.recordCalls[0].kind, 'success-pattern');
    });

    check('store() built a structured MemoryScope from {tenantId, projectId, sessionId}', () => {
        assert.deepStrictEqual(orch.recordCalls[0].scope, {
            tenantId:  'tenant-A',
            projectId: 'proj-Q',
            sessionId: 'sess-1',
        });
    });

    check('store() smuggled relevanceTags into detail.tags', () => {
        const d = orch.recordCalls[0].detail;
        assert.ok(Array.isArray(d.tags), 'detail.tags should be an array');
        assert.deepStrictEqual([...d.tags].sort(), ['edit', 'general-coding']);
    });

    check('store() preserved original detail fields alongside tags', () => {
        const d = orch.recordCalls[0].detail;
        assert.strictEqual(d.commitHash, 'abc123');
        assert.deepStrictEqual(d.editedFiles, ['foo.ts', 'bar.ts']);
    });

    check('store() defaulted importance when legacy shape lacks it', () => {
        assert.strictEqual(orch.recordCalls[0].importance, 0.5);
    });

    // ── 2. store() without relevanceTags shouldn't add an empty tags field ──

    orch = createMockOrchestrator();
    adapter = new LegacyMemorySystemAdapter({ orchestrator: orch });

    await checkAsync('store() with no tags omits detail.tags entirely', async () => {
        await adapter.store({
            tenantId:      'tenant-A',
            sessionId:     'sess-1',
            scope:         'session:sess-1',
            type:          'tool-heuristic',
            tier:          'procedural',
            summary:       'use ripgrep over grep',
            detail:        { tool: 'rg' },
            relevanceTags: [],
        });
        assert.strictEqual(orch.recordCalls[0].detail.tags, undefined);
        assert.strictEqual(orch.recordCalls[0].detail.tool, 'rg');
    });

    // ── 3. recall() translation ─────────────────────────────────────────────

    orch = createMockOrchestrator();
    adapter = new LegacyMemorySystemAdapter({ orchestrator: orch });

    let recallResults;
    await checkAsync('recall() returns RecallResult[] with legacy shape', async () => {
        recallResults = await adapter.recall({
            tenantId:  'tenant-A',
            sessionId: 'sess-1',
            query:     'how did we edit foo',
            topK:      5,
            types:     ['successful-strategy', 'failure-pattern'],
        });
        assert.strictEqual(recallResults.length, 2);
    });

    check('recall() called orchestrator.assembleContext with translated shape', () => {
        assert.strictEqual(orch.assembleCalls.length, 1);
        const c = orch.assembleCalls[0];
        assert.deepStrictEqual(c.scope, { tenantId: 'tenant-A', sessionId: 'sess-1' });
        assert.strictEqual(c.query, 'how did we edit foo');
        assert.strictEqual(c.topK, 5);
        assert.deepStrictEqual([...c.kinds].sort(), ['failure-lesson', 'success-pattern']);
    });

    check('recall() translated MemoryKind back to legacy MemoryType', () => {
        assert.strictEqual(recallResults[0].entry.type, 'successful-strategy');
        assert.strictEqual(recallResults[1].entry.type, 'failure-pattern');
    });

    check('recall() supplied a tier consistent with the kind', () => {
        // success-pattern → procedural
        assert.strictEqual(recallResults[0].entry.tier, 'procedural');
        // failure-lesson → episodic
        assert.strictEqual(recallResults[1].entry.tier, 'episodic');
    });

    check('recall() built legacy single-string scope from structured scope', () => {
        // scope.sessionId present and no projectId → 'session:…'
        assert.strictEqual(recallResults[0].entry.scope, 'session:sess-1');
        // scope had only tenantId → 'tenant:…'
        assert.strictEqual(recallResults[1].entry.scope, 'tenant:tenant-A');
    });

    check('recall() converted ISO timestamps to Unix ms', () => {
        const e = recallResults[0].entry;
        assert.strictEqual(typeof e.createdAt, 'number');
        assert.strictEqual(e.createdAt, Date.parse('2026-04-18T12:00:00.000Z'));
        assert.strictEqual(e.lastReinforcedAt, Date.parse('2026-04-19T00:00:00.000Z'));
    });

    check('recall() mapped recallCount → successCount and importance → confidence', () => {
        const e = recallResults[0].entry;
        assert.strictEqual(e.successCount, 3);
        assert.strictEqual(e.confidence, 0.75);
        assert.strictEqual(e.missCount, 0);
    });

    check('recall() recovered relevanceTags from detail.tags round-trip', () => {
        assert.deepStrictEqual(
            [...recallResults[0].entry.relevanceTags].sort(),
            ['edit', 'general-coding'],
        );
    });

    check('recall() left relevanceTags empty when ranked entry had no tags', () => {
        assert.deepStrictEqual(recallResults[1].entry.relevanceTags, []);
    });

    // ── 4. recall() applies minScore filter ──────────────────────────────────

    orch = createMockOrchestrator();
    adapter = new LegacyMemorySystemAdapter({ orchestrator: orch });

    await checkAsync('recall() with minScore=0.5 drops low-scoring entries', async () => {
        const r = await adapter.recall({
            tenantId:  'tenant-A',
            sessionId: 'sess-1',
            query:     'q',
            topK:      5,
            minScore:  0.5,
        });
        assert.strictEqual(r.length, 1);
        assert.strictEqual(r[0].entry.id, 'rm-1');
    });

    // ── 5. endSession() with hook ────────────────────────────────────────────

    let hookCalls = [];
    orch = createMockOrchestrator();
    adapter = new LegacyMemorySystemAdapter({
        orchestrator: orch,
        endSessionHook: async (t, s) => { hookCalls.push({ t, s }); },
    });

    await checkAsync('endSession() invokes the teardown hook and resolves', async () => {
        await adapter.endSession('tenant-A', 'sess-1');
        assert.deepStrictEqual(hookCalls, [{ t: 'tenant-A', s: 'sess-1' }]);
    });

    // ── 6. endSession() swallows hook errors ────────────────────────────────

    let warnings = [];
    orch = createMockOrchestrator();
    adapter = new LegacyMemorySystemAdapter({
        orchestrator: orch,
        endSessionHook: async () => { throw new Error('redis is down'); },
        logger: { warn: (m, meta) => warnings.push({ m, meta }), debug: () => {} },
    });

    await checkAsync('endSession() never throws even if hook fails, logs at warn', async () => {
        await adapter.endSession('tenant-A', 'sess-1');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0].m, /endSessionHook failed/);
        assert.strictEqual(warnings[0].meta.error, 'redis is down');
    });

    // ── 7. reinforce / penalise are non-throwing no-ops ─────────────────────

    warnings = [];
    orch = createMockOrchestrator();
    adapter = new LegacyMemorySystemAdapter({
        orchestrator: orch,
        logger: { warn: (m, meta) => warnings.push({ m, meta }) },
    });

    await checkAsync('reinforceMemory() is a non-throwing warn', async () => {
        await adapter.reinforceMemory('m-1', 'tenant-A');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0].m, /reinforceMemory has no equivalent/);
    });

    await checkAsync('penaliseMemory() is a non-throwing warn', async () => {
        await adapter.penaliseMemory('m-1', 'tenant-A');
        assert.strictEqual(warnings.length, 2);
        assert.match(warnings[1].m, /penaliseMemory has no equivalent/);
    });

    // ── Done ────────────────────────────────────────────────────────────────

    console.log('====================================');
    console.log(`Passed: ${passed.length}    Failed: ${failed.length}`);
    if (failed.length > 0) {
        console.log('FAILURES:');
        for (const f of failed) console.log(`  - ${f.label}: ${f.message}`);
        process.exit(1);
    }
    process.exit(0);
})();
