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
import type { IWorkingMemory, MemoryScope } from '@oweibo/core-contracts';
export declare class WorkingMemory implements IWorkingMemory {
    readonly scope: MemoryScope;
    private readonly data;
    constructor(scope: MemoryScope);
    set<T>(key: string, value: T): void;
    get<T>(key: string): T | undefined;
    has(key: string): boolean;
    delete(key: string): void;
    keys(): readonly string[];
    snapshot(): Readonly<Record<string, unknown>>;
    clear(): void;
}
/**
 * WorkingMemoryRegistry — orchestrator-side factory that hands out one
 * WorkingMemory per (tenant, task) pair. Keyed by a composite string so two
 * concurrent tasks from the same tenant don't collide.
 */
export declare class WorkingMemoryRegistry {
    private readonly byKey;
    for(scope: MemoryScope): WorkingMemory;
    release(scope: MemoryScope): void;
    private keyFor;
}
//# sourceMappingURL=WorkingMemory.d.ts.map