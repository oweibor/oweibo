# Memory subsystem migration guide

## TL;DR

The legacy `IMemorySystem` (in `agentic/IMemorySystem.ts`, implemented by
`UnifiedMemorySystem`) is **deprecated**. New code should depend on
`IMemoryOrchestrator` from `@oweibo/core-contracts`.

Existing callers can keep their `IMemorySystem`-shaped dependency by wrapping
a `MemoryOrchestrator` in `LegacyMemorySystemAdapter` — no call-site changes
required, and the underlying storage is unified through the new orchestrator
tiers.

## Why migrate

| Concern | Legacy `IMemorySystem` | New `IMemoryOrchestrator` |
|---|---|---|
| Tenant isolation | Runtime check on `tenantId` field | Compile-time mandatory `MemoryScope.tenantId` |
| Memory categories | 4 `MemoryType` values | 11 `MemoryKind` values, closed enum |
| Tiers | 3 implicit tiers (`episodic`/`semantic`/`procedural`) baked into LTM | 4 explicit tiers (Working / STM / Project / Semantic), discrete classes |
| Scope shape | Single string (`'session:abc'`) | Structured `MemoryScope` object |
| Context retrieval | `recall()` returns raw vector results | `assembleContext()` returns ranked, deduped, budget-aware bundle including project + session + memories + pre-formatted prompt block |
| Working memory | None — callers passed untyped state through opts bags | `IWorkingMemory` with typed get/set per (tenant, task) |
| Rolling summary | Not surfaced in interface | `recordTurn` folds evicted turns via injected `ConversationSummarizer` |
| Consolidation | One `successful-strategy` write per task | `consolidate(scope, outcome)` extracts decisions, failures, invariants, preferences, open-questions, code-landmarks, success patterns |

## Migration paths by caller

### Path 1 — Stay on `IMemorySystem` (drop-in shim)

For callers that aren't ready to refactor their interface dependency, wrap a
`MemoryOrchestrator` in `LegacyMemorySystemAdapter` at the wiring site:

```ts
import {
  MemoryOrchestrator,
  WorkingMemoryRegistry,
  SemanticMemoryAdapter,
  LegacyMemorySystemAdapter,
} from '@oweibo/core-engine';

const orchestrator = new MemoryOrchestrator({
  working:   new WorkingMemoryRegistry(),
  shortTerm: stmStoreInstance,        // your IShortTermMemoryStore
  projects:  projectRegistryInstance, // your IProjectRegistry
  semantic:  new SemanticMemoryAdapter(legacyLtmStore), // bridges over your existing LongTermMemoryStore
  summarizer: yourLlmSummarizer,
});

const memorySystem = new LegacyMemorySystemAdapter({
  orchestrator,
  endSessionHook: async (tenantId, sessionId) => {
    // Optional: tear down legacy STM Redis keys held outside the orchestrator's STM
  },
  logger: yourLogger,
});

// Inject `memorySystem` wherever an IMemorySystem was expected.
```

Every `store()` and `recall()` call on `memorySystem` now flows through the
orchestrator and ends up in the same Qdrant collections as before — the seam
moved, the storage didn't.

### Path 2 — Switch the consumer to `IMemoryOrchestrator` directly

Recommended for any code being refactored regardless. Replace the constructor
parameter type and update call sites:

| Legacy call | New call |
|---|---|
| `memorySystem.store({tenantId, sessionId, scope: 'session:x', type: 'successful-strategy', tier: 'episodic', summary, detail, relevanceTags})` | `orchestrator.record({scope: {tenantId, sessionId}, kind: 'success-pattern', summary, detail: {...detail, tags: relevanceTags}, importance: 0.5})` |
| `memorySystem.recall({tenantId, sessionId, query, topK, types})` | `orchestrator.assembleContext({scope: {tenantId, sessionId}, query, kinds: types?.map(legacyTypeToKind), topK})` then read `.rankedMemories` |
| `memorySystem.warmForTask({tenantId, sessionId, taskGoal})` | Same as recall — `warmForTask` was a heuristic blend that the new contract subsumes under `assembleContext` |
| `memorySystem.endSession(tenantId, sessionId)` | Either drop the call (orchestrator STM has TTL cleanup) or call your own teardown directly. To persist a session-end summary, call `orchestrator.consolidate(scope, taskOutcome)` while you still have the outcome in scope. |
| `memorySystem.reinforceMemory(id, tenantId)` | Drop or replace with `orchestrator.assembleContext({…, kinds: [...]})` — semantic recall already reinforces implicitly via `recall({reinforce: true})` |
| `memorySystem.penaliseMemory(id, tenantId)` | No equivalent. The contract treats penalisation as out-of-band (e.g. surface via `consolidate(outcome.failures)`) |

### Mapping reference

`MemoryType` (legacy) → `MemoryKind` (contract):

| Legacy `MemoryType` | Contract `MemoryKind` |
|---|---|
| `successful-strategy` | `success-pattern` |
| `failure-pattern` | `failure-lesson` |
| `tool-heuristic` | `tool-heuristic` |
| `domain-knowledge` | `domain-fact` |

Reverse map (used by the adapter on recall) lives in
`LegacyMemorySystemAdapter.KIND_TO_LEGACY` — covers all 11 kinds with a
best-effort default tier per kind.

## Single live consumer

Today the only consumer of `IMemorySystem` is `ConversationalLoop` in
`general-coding/`. To migrate it, change the wiring site that constructs
`ConversationalLoop` to inject a `LegacyMemorySystemAdapter` instead of a
`UnifiedMemorySystem`. No changes to `ConversationalLoop` itself are required.

After that swap, `UnifiedMemorySystem` and the legacy `IMemorySystem` interface
have no remaining consumers and can be deleted in a follow-up PR.

## What does NOT translate cleanly

- **`relevanceTags`**: the contract has no first-class tags field. The adapter
  smuggles them through `detail.tags`, which `SemanticMemoryAdapter` lifts
  back into LTM `relevanceTags` on the way to disk. Round-trip works for the
  legacy adapter path; non-tag-aware contract callers ignore them.
- **`userId`**: the contract's `MemoryScope` has no userId field. Legacy
  user-scoped writes lose the userId on translation. If you need
  per-user memory, store userId in `detail.userId` and filter at recall.
- **`tier`**: the contract uses `MemoryKind` to subsume tier semantics. The
  reverse mapping picks a default tier per kind — see `KIND_TO_LEGACY`.
- **Explicit reinforce / penalise**: the new contract treats reinforcement as
  implicit (`recall({reinforce: true})`). The adapter's `reinforceMemory` /
  `penaliseMemory` log warnings and resolve as no-ops to keep legacy
  fire-and-forget patterns from crashing.

## Removal timeline

Hard removal is gated on `ConversationalLoop` (the only known consumer)
switching to depend on `IMemoryOrchestrator` directly. Once that lands:

1. Delete `agentic/IMemorySystem.ts`
2. Delete `agentic/memory/LegacyMemorySystemAdapter.ts`
3. Drop the corresponding `export`s from `agentic/memory/index.ts` and the
   package root `index.ts`
4. Drop `UnifiedMemorySystem` re-exports from anywhere they leak

No data migration is required — `SemanticMemoryAdapter` continues to read
from the same Qdrant collections.
