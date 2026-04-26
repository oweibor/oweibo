"use strict";
/**
 * WorkingMemory — tier 1. Per-turn, in-process scratchpad.
 *
 * This is the tier that replaces the `(ctx as unknown as Record<string, unknown>)`
 * untyped-bag pattern in pipeline stages. It is deliberately boring:
 *   • In-process Map.
 *   • Scoped to a single MemoryScope (typically scope.taskId).
 *   • No persistence. Discarded at turn end.
 *
 * Think of it as a function-local variable table that survives across stages
 * within a single pipeline run but never leaks to another run.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkingMemoryRegistry = exports.WorkingMemory = void 0;
class WorkingMemory {
    scope;
    data = new Map();
    constructor(scope) { this.scope = scope; }
    set(key, value) { this.data.set(key, value); }
    get(key) { return this.data.get(key); }
    has(key) { return this.data.has(key); }
    delete(key) { this.data.delete(key); }
    keys() { return [...this.data.keys()]; }
    snapshot() {
        const out = {};
        for (const [k, v] of this.data)
            out[k] = v;
        return Object.freeze(out);
    }
    clear() { this.data.clear(); }
}
exports.WorkingMemory = WorkingMemory;
/**
 * WorkingMemoryRegistry — orchestrator-side factory that hands out one
 * WorkingMemory per (tenant, task) pair. Keyed by a composite string so two
 * concurrent tasks from the same tenant don't collide.
 */
class WorkingMemoryRegistry {
    byKey = new Map();
    for(scope) {
        const key = this.keyFor(scope);
        let mem = this.byKey.get(key);
        if (!mem) {
            mem = new WorkingMemory(scope);
            this.byKey.set(key, mem);
        }
        return mem;
    }
    release(scope) {
        const key = this.keyFor(scope);
        const mem = this.byKey.get(key);
        if (mem) {
            mem.clear();
            this.byKey.delete(key);
        }
    }
    keyFor(scope) {
        // taskId is the finest-grained identifier available for a turn; fall back
        // to sessionId when a task hasn't been created yet (e.g. planning phase).
        // Refuse anonymous scopes — silently sharing a single bucket across all
        // anonymous turns of a tenant is a correctness hazard.
        const id = scope.taskId ?? scope.sessionId;
        if (!id) {
            throw new Error('WorkingMemoryRegistry: scope must include taskId or sessionId; ' +
                `got tenantId=${scope.tenantId} with neither`);
        }
        return `${scope.tenantId}::${id}`;
    }
}
exports.WorkingMemoryRegistry = WorkingMemoryRegistry;
//# sourceMappingURL=WorkingMemory.js.map