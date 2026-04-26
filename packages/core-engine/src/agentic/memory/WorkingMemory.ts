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

export class WorkingMemory implements IWorkingMemory {
  readonly scope: MemoryScope;
  private readonly data = new Map<string, unknown>();

  constructor(scope: MemoryScope) { this.scope = scope; }

  set<T>(key: string, value: T): void { this.data.set(key, value); }
  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined; }
  has(key: string): boolean { return this.data.has(key); }
  delete(key: string): void { this.data.delete(key); }
  keys(): readonly string[] { return [...this.data.keys()]; }

  snapshot(): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.data) out[k] = v;
    return Object.freeze(out);
  }

  clear(): void { this.data.clear(); }
}

/**
 * WorkingMemoryRegistry — orchestrator-side factory that hands out one
 * WorkingMemory per (tenant, task) pair. Keyed by a composite string so two
 * concurrent tasks from the same tenant don't collide.
 */
export class WorkingMemoryRegistry {
  private readonly byKey = new Map<string, WorkingMemory>();

  for(scope: MemoryScope): WorkingMemory {
    const key = this.keyFor(scope);
    let mem = this.byKey.get(key);
    if (!mem) {
      mem = new WorkingMemory(scope);
      this.byKey.set(key, mem);
    }
    return mem;
  }

  release(scope: MemoryScope): void {
    const key = this.keyFor(scope);
    const mem = this.byKey.get(key);
    if (mem) { mem.clear(); this.byKey.delete(key); }
  }

  private keyFor(scope: MemoryScope): string {
    // taskId is the finest-grained identifier available for a turn; fall back
    // to sessionId when a task hasn't been created yet (e.g. planning phase).
    // Refuse anonymous scopes — silently sharing a single bucket across all
    // anonymous turns of a tenant is a correctness hazard.
    const id = scope.taskId ?? scope.sessionId;
    if (!id) {
      throw new Error(
        'WorkingMemoryRegistry: scope must include taskId or sessionId; ' +
        `got tenantId=${scope.tenantId} with neither`,
      );
    }
    return `${scope.tenantId}::${id}`;
  }
}
