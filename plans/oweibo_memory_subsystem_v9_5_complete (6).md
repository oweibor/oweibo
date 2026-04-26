# oweibo — Memory Subsystem: Complete Specification (v9.5)

> **Status:** Standalone canonical reference. Supersedes the incremental documents
> `oweibo_ltm_v9_5_memory_improvements.md` and `oweibo_memory_v9_5_1.md`.
> Apply this document in full against the v9.4.4 base plan. No prior memory patches are required.
>
> **Scope:** All STM, LTM, and cross-cutting memory concerns — data model, storage classes,
> background services, prompt assembly, observability, CLI, infra, migration, and tests.
> No changes to the factory pipeline, swarm coordination, sandbox, channel gateway, or skills system.
>
> **Source base:** v9.4.4 `§12.5 LongTermMemoryStore` and its consumers (`BaseAgent`,
> `ContextPruner`, `CognitiveEngine`, `ConversationalLoop`).

---

## Table of Contents

0. [Memory Categories & Ownership](#0-memory-categories--ownership)
1. [Gap Inventory](#1-gap-inventory) *(includes §1.6 Kilo Pipeline Integration Gaps — P-1 through P-6)*
2. [Data Model](#2-data-model)
3. [TenantKeyBuilder Extensions](#3-tenantKeyBuilder-extensions)
4. [EmbeddingCache](#4-embeddingcache)
5. [LongTermMemoryStore](#5-longtermememorystore)
6. [ShortTermMemoryStore](#6-shorttermememorystore)
   6a. [UserProfileStore](#6a-userprofilestore)
   6b. [PreferenceNudgeService](#6b-preferencenudgeservice)
7. [MemoryDecayService](#7-memorydecayservice)
8. [MemoryScopePromoter](#8-memoryscopepromoter)
9. [MemoryConsolidator](#9-memoryconsolidator)
10. [STMCompressor](#10-stmcompressor)
11. [MemoryWarmer](#11-memorywarmer)
12. [PromptBudgetEnforcer](#12-promptbudgetenforcer)
13. [IMemorySystem Facade](#13-imemorysystem-facade)
14. [MemoryTracer](#14-memorytracer)
15. [LtmBackupService](#15-ltmbackupservice)
16. [LtmMigrationService](#16-ltmmigrationservice)
17. [BaseAgent Memory Integration](#17-baseagent-memory-integration)
18. [CognitiveEngine Integration](#18-cognitiveengine-integration)
19. [ConversationalLoop Integration](#19-conversationalloop-integration)
20. [SessionStore TTL](#20-sessionstore-ttl)
21. [Bootstrap: ensureCollections](#21-bootstrap-ensurecollections)
22. [Memory CLI](#22-memory-cli)
23. [Infra: K8s CronJobs](#23-infra-k8s-cronjobs)
24. [Dependency Graph](#24-dependency-graph)
25. [Test Coverage](#25-test-coverage)
26. [Kilo Pipeline Integration](#26-kilo-pipeline-integration)
    26.1 [invariants.yaml — Remove as Write Target](#261-invariantsyaml--remove-as-write-target-p-1)
    26.2 [Gate Feedback Wiring: reinforce / penalise](#262-gate-feedback-wiring-reinforce--penalise-p-2)
    26.3 [project_context Collection Retirement](#263-project_context-collection-retirement-p-3)
    26.4 [Embedding Dimension — Hardware Profile Strategy](#264-embedding-dimension--hardware-profile-strategy-p-4)
    26.5 [Pipeline Stage STM Writes](#265-pipeline-stage-stm-writes-p-5)
    26.6 [JS Pipeline → TypeScript IMemorySystem Bridge](#266-js-pipeline--typescript-imemorysystem-bridge-p-6)
    26.7 [Kilo Pipeline Integration Tests](#267-kilo-pipeline-integration-tests)

---

## 0. Memory Categories & Ownership

This section is the canonical reference for what gets stored where, who owns it, and how it reaches the agent prompt. Every other section in this spec implements one part of this contract. When in doubt about ownership, start here.

### 0.1 Storage owners

| Category | What it holds | Canonical owner | How it reaches the prompt |
|---|---|---|---|
| **User preferences** | Output format, skill level, communication style, language, recurring feedback patterns | **Postgres** (`user_profiles` + `user_preferences`) — sole write target; Redis is cache-only | Loaded by `UserProfileStore.loadProfile()`, rendered by `renderProfile()`, injected as `PromptComponents.userProfile` — a fixed block, never recalled semantically, never truncated |
| **Project memory** | Architecture decisions, naming conventions, dependency choices, prior task outcomes per project | **Qdrant LTM** at `scope: 'project:{projectId}'` — written by `CognitiveEngine` at task end | Semantically recalled by `MemoryWarmer` (PROJECT_BOOST=0.08); competes with other LTM channels on score |
| **Tenant-wide knowledge** | Promoted procedural patterns shared across all agents for a tenant | **Qdrant LTM** at `scope: 'tenant:{tenantId}'` — written by `MemoryScopePromoter` | Semantically recalled by `MemoryWarmer` (SHARED_BOOST=0.03); lowest-priority channel |
| **Agent task memory** | Role-scoped episodic outcomes for a specific task | **Qdrant LTM** at `scope: '{role}:{taskId}'` — written by `CognitiveEngine` at task end | Semantically recalled by `MemoryWarmer` (AGENT_BOOST=0.10); highest-priority channel |
| **User episodic events** | Non-preference user events (e.g. "user completed onboarding", "user triggered billing upgrade") | **Qdrant LTM** at `scope: 'user:{userId}'` — written explicitly by application code | Semantically recalled like any other LTM scope — NOT for preferences |
| **Session turns** | Current-session turn summaries and tool outputs | **Redis Stack VSS** (warm layer) + in-process Map (hot layer) — written by `ShortTermMemoryStore.store()` | Recalled by `MemoryWarmer` (STM_BOOST=0.06, normalised to LTM composite scale); also read by `PreferenceNudgeService` at session end |
| **Crash-recovery LTM** | Task-end LTM write when `CognitiveEngine` did not reach its normal consolidation path | **Qdrant LTM** at `scope: 'session:{sessionId}'` — written by `UnifiedMemorySystem.endSession()` recovery path | Not recalled during normal operation; serves as a safety net for nightly consolidation |

### 0.2 The `user:{userId}` scope — explicit contract

`scope: 'user:{userId}'` in LTM is reserved for **episodic user events only** — things that happened to or were done by the user that are worth remembering as facts (e.g. onboarding completion, feature adoption milestones). It is **not** a preference store.

**Preferences must never be written to LTM.** The `'user-preference'` value is absent from `MemoryType` by design. Any code writing a `MemoryEntry` with a preference-like summary at `scope: 'user:{userId}'` is a bug. The ESLint `no-raw-scope-string` rule blocks raw `` `user:${userId}` `` construction; all scope strings must go through `TenantKeyBuilder.userScope()` to make every usage auditable by grep.

> **Audit result (v9.5):** grep of all `TenantKeyBuilder.userScope()` call sites confirms zero calls that write preference-like content. The only writer is application code for explicit episodic events.

### 0.3 Prompt assembly — what lands where

The canonical prompt assembly chain, in injection order:

```
repoMap
projectRules
skills
userProfile       ← fixed, always present, never truncated (UserProfileStore → Postgres)
warmMemory        ← recalled: agent + project + STM + tenant channels (MemoryWarmer → LTM + STM)
conversationHistory
systemPrompt      ← never truncated
```

Truncation order under budget pressure (leftmost evicted first):
`repoMap → conversationHistory → warmMemory → skills → projectRules`

`userProfile` and `systemPrompt` are exempt from truncation — `PromptBudgetEnforcer` reserves their token budget before the truncation loop runs.

### 0.4 Write paths — who calls what

```
Agent turn end        → IMemorySystem.store()     → STM warm + hot layer
Session end           → PreferenceNudgeService     → UserProfileStore.upsertPreference() → Postgres
Session end           → UnifiedMemorySystem.endSession() → crash-recovery LTM if needed → STM teardown
Task end              → CognitiveEngine            → LTM (task scope + failure patterns)
Nightly 03:00 UTC     → MemoryDecayService         → LTM eviction + Postgres archive
Nightly 03:00 UTC     → MemoryConsolidator         → LTM episodic → semantic/procedural
Nightly 03:00 UTC     → LtmBackupService           → Qdrant snapshot → S3
Recurring success     → MemoryScopePromoter        → LTM tenant scope promotion
```

### 0.5 Cross-reference

| Section | Owns / Implements |
|---|---|
| §2 Data Model | `MemoryEntry`, `MemoryType`, `MemoryTier`, scope conventions |
| §6 ShortTermMemoryStore | STM hot + warm layer |
| §6a UserProfileStore | User preference Postgres ownership, `renderProfile()`, `upsertPreference()` |
| §6b PreferenceNudgeService | Session-end preference signal detection → `upsertPreference()` |
| §11 MemoryWarmer | Four-channel LTM + STM soft-boost merge |
| §12 PromptBudgetEnforcer | Token budget enforcement; userProfile exemption |
| §18 CognitiveEngine | Task-end LTM writes |
| §19 ConversationalLoop | Session orchestration; nudge trigger; prompt assembly |

---

## 1. Gap Inventory

All thirty gaps addressed by this document, inherited from two audit passes against v9.4.4.

### 1.1 LTM Gaps (from v9.4.4 `§12.5`)

| ID | Gap | Severity | Fix |
|----|-----|----------|-----|
| G-M1 | No tenant isolation on the Qdrant collection | 🔴 Critical | Per-tenant collections via `TenantKeyBuilder.ltmCollection()` |
| G-M2 | `scope` attached via `unknown` spread — TypeScript bypass | 🔴 Critical | `scope` + `tenantId` as first-class `MemoryEntry` fields |
| G-M3 | No memory decay / eviction | 🟠 High | `MemoryDecayService` with exponential half-life + Postgres archive |
| G-M4 | `reinforce()` re-embeds vector unnecessarily | 🟠 High | `qdrant.setPayload()` — no re-embed on reinforce |
| G-M5 | Pure cosine similarity ignores recency | 🟠 High | Composite score: `α·cosine + β·recency + γ·success_rate` |
| G-M6 | No deduplication on write | 🟡 Medium | Near-duplicate check (cosine > 0.93, same scope) before upsert |
| G-M7 | Flat `MemoryType` — no tier taxonomy | 🟡 Medium | `MemoryTier`: `episodic / semantic / procedural` with per-tier decay rates |
| G-M8 | No cross-scope promotion | 🟡 Medium | `MemoryScopePromoter` — graduates heuristics to `tenant:{id}` scope |
| G-M9 | No background consolidation ("sleep cycle") | 🟡 Medium | `MemoryConsolidator` — clusters episodics → mints semantic memories |
| G-M10 | `consolidateFromTask` writes failures sequentially | 🟢 Low | `Promise.all` for batch writes |
| G-M11 | No pre-task memory warm-up | 🟢 Low | `MemoryWarmer.warmForTask()` injected into prompt chain |
| G-M12 | Recall scores discarded — no confidence gating | 🟢 Low | `RecallResult { entry, score }` + `minScore` filter on all recall paths |

### 1.2 STM Gaps (from v9.4.4 implicit STM — `DistributedContextStore`, `SessionStore`)

| ID | Gap | Severity | Fix |
|----|-----|----------|-----|
| STM-1 | No STM vector store — only Redis key-value + raw history | 🟠 High | `ShortTermMemoryStore`: two-layer store — hot in-process Map (last `stmHotWindowSize` turns, zero external I/O) + warm Redis Stack VSS HNSW index per tenant with native TTL; no Qdrant collections for STM |
| STM-2 | No token-budget-aware prompt assembly | 🔴 Critical | `PromptBudgetEnforcer` — mandatory gate after all prompt sections assembled |
| STM-3 | `SessionStore` TTL fixed at 7 days, not per-tenant | 🟡 Medium | Vault key `oweibo/tenants/{tenantId}/memory/session-ttl-days` |
| STM-4 | No STM compression before LTM consolidation | 🟡 Medium | `STMCompressor` — distills raw `DecisionLog[]` before LTM write |
| STM-5 | No pre-turn STM warm-up symmetric to LTM | 🟢 Low | `MemoryWarmer` accepts `sessionId` — merges STM + LTM warm-up |
| STM-6 | No Langfuse spans for STM operations | 🟢 Low | `MemoryTracer` — spans for all STM/LTM operations |

### 1.3 Cross-Cutting Gaps

| ID | Gap | Severity | Fix |
|----|-----|----------|-----|
| X-1 | `PromptBudgetEnforcer` — sketched in §22.26, never implemented | 🔴 Critical | Full implementation in §12 |
| X-2 | `TenantKeyBuilder` not wired to LTM/STM collection names | 🟠 High | Extended `TenantKeyBuilder` + ESLint rule enforcement |
| X-3 | No unified `IMemorySystem` facade — agents call tiers directly | 🟡 Medium | `IMemorySystem` interface + `UnifiedMemorySystem` implementation |
| X-4 | No memory CLI tooling | 🟢 Low | `oweibo memory {list,recall,purge,export,doctor,decay}` |

### 1.4 Residual LTM Operational Gaps (post-first-pass audit)

| ID | Gap | Severity | Fix |
|----|-----|----------|-----|
| LTM-1 | Decay + consolidation use unbounded scroll — O(N) at 1000+ tenants | 🟠 High | `maxPointsPerCycle` + adaptive batching + p-limit concurrency |
| LTM-2 | `MemoryConsolidator` uses generic `ILLMClient` — can hit large model | 🟡 Medium | Route through `ModelRouter` to small model; Vault override |
| LTM-3 | No backup / disaster-recovery for Qdrant collections | 🟠 High | `LtmBackupService` — daily Qdrant snapshots to S3 |
| LTM-4 | Promotion threshold is global — not per-tenant | 🟡 Medium | Vault key `oweibo/tenants/{tenantId}/memory/promotion-threshold` |
| LTM-5 | No governance gate on memory content | 🟢 Low | `runGovernanceScan()` in `store()` — reuses skill governance patterns |
| LTM-6 | `MemoryWarmer` output not token-budgeted | 🟢 Low | `maxTokens` param on `warmForTask()` with `ModelRouter.countTokens()` |
| LTM-7 | Schema migration is one-shot and not idempotent | 🟡 Medium | `LtmMigrationService` with `schemaVersion` in collection metadata |
| LTM-8 | No Langfuse spans for composite scoring, decay, or promotion | 🟢 Low | `MemoryTracer` spans across all memory operations |

### 1.5 Residual Recall-Efficiency Gaps (addressed by this revision)

Identified by cross-reading the v9.5 spec against its own implementation code.

| ID | Gap | Severity | Fix |
|----|-----|----------|-----|
| R-1 | `warmMemory` evicted first by `PromptBudgetEnforcer` — recalled context was lowest-priority component | 🔴 Critical | Truncation order changed to: `repoMap → conversationHistory → warmMemory → skills → projectRules` |
| R-2 | STM and LTM scores on different scales merged by `UnifiedMemorySystem` — sort order meaningless | 🔴 Critical | STM cosine normalised to LTM composite scale: `0.60·cosine + 0.25` before merge |
| R-3 | `must_not: { match: { value: true } }` never matches a Unix timestamp — all episodics re-consolidated every cycle | 🔴 Critical | Replaced with `is_null: { key: 'consolidatedAt', is_null: true }` in `must` |
| R-4 | Task crash before task-end loses all mid-task LTM writes — no recovery path | 🔴 Critical | `endSession()` crash-recovery: drain STM → `STMCompressor.compressEntries()` → LTM write if no existing scope entry |
| R-5 | `recallForAgent()` drops `minScore` and `tiers` — gap G-M12 and G-M7 bypassed for `BaseAgent` | 🟠 High | `recallForAgent()` now forwards `minScore` and `tiers` to `recall()` |
| R-6 | `MemoryWarmer` rigid per-tier topK split — empty tier wastes slots | 🟠 High | Each tier queries full topK; soft-boost merge selects best across all tiers |
| R-7 | `MemoryTracer` absent from `LongTermMemoryStore` constructor — LTM recall spans never emitted | 🟠 High | `tracer?: MemoryTracer` added to `LongTermMemoryStore` constructor; `recall()` wrapped in `traceRecall()` |
| R-8 | `consolidateCluster()` silently discards malformed LLM output — no retry, metric, or alert | 🟠 High | One retry + `logger.warn` + `oweibo_ltm_consolidation_parse_failure_total` metric increment |
| R-9 | `archiveEntries()` builds SQL by string interpolation — injection risk | 🟠 High | Replaced with `pg` parameterized bulk insert using `$1…$(7n)` placeholders |
| R-10 | Cross-tier deduplication absent — STM + LTM can return the same consolidated memory twice | 🟡 Medium | Summary-fingerprint deduplication in `UnifiedMemorySystem.recall()` before final sort |
| R-11 | `clusterByTags()` clusters by `tags[0]` only — multi-tag memories miss cross-topic consolidation | 🟡 Medium | Entry indexed under all `relevanceTags`; `consolidatedAt` prevents double-processing |
| R-12 | `CONSOLIDATION_WINDOW_DAYS` and `MIN_CLUSTER_SIZE` hardcoded — inconsistent with per-tenant Vault pattern | 🟡 Medium | Vault path `oweibo/tenants/{tenantId}/memory/consolidation` with `windowDays` + `minClusterSize` |
| R-13 | `LtmBackupService.runBackupCycle()` uses `Promise.all` with no concurrency cap | 🟡 Medium | `p-limit` with `maxConcurrentTenants` — same pattern as `MemoryDecayService` |
| R-14 | `lastAccessedAt` tracked but never updated on access — field misleading for analytics | 🟢 Low | Fire-and-forget `setPayload` update in `recall()` after result set is known |
| R-15 | `MemoryConsolidator` fires one LLM call per qualifying cluster with no cap — unbounded cost at scale | 🔴 Critical | `maxClustersPerCyclePerTenant: 20` in `LongTermMemoryConfig`; clusters sorted largest-first; cap Vault-overridable per-tenant; `oweibo_ltm_consolidation_cluster_cap_total` metric emitted when cap is hit |
| R-16 | `ShortTermMemoryStore` created one Qdrant collection per session — orphaned crash sessions accumulated, Qdrant collection-count limits were reachable at scale, and heavyweight collection overhead was paid for tiny corpora | 🟠 High | Replaced with two-layer store: hot in-process Map (zero external I/O) + warm Redis Stack VSS HNSW per tenant with native per-entry TTL. No collection management. Session isolation via `@sessionId` tag filter. `maxStmEntriesPerSession: 500` enforced via atomic Redis INCR counter. `StorageCapExceededError` thrown if exceeded. `oweibo memory stm-reap` becomes a diagnostic showing orphaned counter keys. |
| R-17 | `LongTermMemoryStore.store()` has no hard entry-count ceiling — runaway writes or migration bugs can fill collections unboundedly | 🟠 High | `maxLtmEntriesPerTenant: 100_000` in `LongTermMemoryConfig`; checked via `getCollection().points_count` before upsert; `LtmCapExceededError` thrown if exceeded |
| R-18 | `MemoryEntry` and `STMEntry` have no `userId` field — all users on a tenant share one undifferentiated memory pool; per-user preferences are structurally unrepresentable | 🔴 Critical | `userId?: string` added to `MemoryEntry` and `STMEntry`; new `scope: 'user:{userId}'` for per-user memories; `UserProfileStore` loads and caches user profiles from Postgres; `PromptComponents.userProfile` injected as a fixed (non-recalled) block |
| R-19 | `MemoryEntry` has no `projectId` field — all project memories share `scope: 'tenant:{tenantId}'`; a tenant with multiple projects cannot isolate their semantic memories | 🔴 Critical | `projectId?: string` added to `MemoryEntry`; new `scope: 'project:{projectId}'` alongside existing scopes; `MemoryWarmer` queries project scope with higher boost than shared tenant scope; Qdrant payload index added for `projectId` |
| R-20 | `MemoryType` has no preference type — user working-style preferences have no storage path and compete with task memories in recall | 🟠 High | `'user-preference'` added to `MemoryType`; `UserProfileStore` writes preferences via `LongTermMemoryStore` at `scope: 'user:{userId}'`; preferences are injected via `userProfile` block, never surfaced by semantic recall |
| R-21 | `UserProfileStore` has three disconnected data owners with no canonical write target — `upsertPreference()` writes to LTM but `loadProfile()` returns early from Postgres and never reads those LTM entries; preferences accumulate, decay, consume LTM quota, and are silently ignored for any user with an existing Postgres row | 🔴 Critical | Postgres is the sole canonical owner. `user-preference` removed from `MemoryType`. `user_preferences` normalised table added (tenant_id, user_id, key, value, confidence). `upsertPreference()` writes to `user_preferences` via `UPSERT ON CONFLICT`. `loadProfile()` simplified to Redis → Postgres only — no LTM fallback, no embedding call. `UserProfileStore` no longer depends on `LongTermMemoryStore`. |

### 1.6 Kilo Pipeline Integration Gaps

Identified by cross-reading this spec against the actual running implementation in `kilo/pipeline/src/`. The plan above is written entirely against `packages/core-engine` (TypeScript). The kilo pipeline is a separate Node.js service (`kilo/pipeline/src/`, CommonJS) that calls Qdrant directly via `services/memory.js` and `services/qdrant.js`, bypassing every isolation, budgeting, and feedback guarantee specified in §§2–25. These gaps are architectural seams, not code-quality issues.

| ID | Gap | Severity | Fix |
| --- | --- | --- | --- |
| P-1 | `invariants.yaml` is a dual write target: `engine.js` uses `appendFileSync` and `decay.js` uses `tmp+rename` rewrite — concurrent pipeline workers (or a decay cycle racing a promotion write) create a TOCTOU race window. The `appendFileSync` is only POSIX-atomic under `PIPE_BUF` (~4 KB); larger writes and concurrent renames silently corrupt the file | 🔴 Critical | `project_invariants` Qdrant collection is the sole write target. `invariants.yaml` becomes a read-only human-inspection artifact generated on demand by `oweibo memory export-invariants`. All `fs.appendFileSync`, `removeFromYaml`, and `writeToStaging` file writes in `engine.js` and `decay.js` are removed. See §26.1. |
| P-2 | `penalise()` / `reinforce()` have no callers in the pipeline gate system — `false_positive_count` and `hit_count` in Qdrant `project_invariants` are read by `decay.js` for quality-based demotion but are never updated by gate runners. Quality-based decay therefore fires on stale or zero counts, making it functionally dead for all invariants that have never been manually corrected | 🟠 High | Gate runners call `penalise()` when an invariant fires but the task is subsequently promoted via human override (supervised mode). Gate runners call `reinforce()` after a task passes all gates on the first attempt without requiring ladder retries. Both feedback paths are wired in the `IMemorySystem` adapter. See §26.2. |
| P-3 | `project_context` Qdrant collection uses `threshold: 0, limit: 50` in `COLLECTION_CONFIG` — all 50 entries are retrieved and injected regardless of relevance score. On resource-constrained hardware targets (qwen2.5-coder:1.5b, ~4 K context window), this dump consumes the entire context window before the task instruction is even read. The 4 000-token truncation cap in `formatMemoryBlock` operates on the formatted string after injection, not before retrieval | 🔴 Critical | `project_context` collection is retired and its entries migrated into the unified `agent-ltm:{tenantId}` collection as `tier: 'semantic'`, `scope: 'tenant:{tenantId}'`. Retrieval is replaced by `MemoryWarmer`'s tenant-scope channel with `minScore: 0.45` and the existing per-tenant token budget from `PromptBudgetEnforcer`. The flat `limit: 50` with no floor is eliminated. See §26.3. |
| P-4 | `LtmMigrationService.runMigration1to2()` calls `createCollection(to, { vectors: { size: 1536 } })` then copies vectors from the source collection verbatim. The source collection was written by `all-MiniLM-L6-v2` (384-dim). Qdrant rejects every `upsert` with a `VectorDimensionError` because 384 ≠ 1536 — every migrated point fails silently. Additionally, `1536` is hardcoded and does not reflect the actual `embedFn` dimension, which varies by hardware profile | 🔴 Critical | `LtmMigrationService` accepts `embedFn` as a constructor parameter. `runMigration1to2` probes the target dimension from `embedFn` before creating the collection, then re-embeds each point's `summary` field using `embedFn` rather than copying the existing vector. The hardcoded `1536` is removed from both `createCollection` and `ensureMemoryCollections`. See §26.4. |
| P-5 | Pipeline stages (Architect, Executor, Reviewer, gate runners) share inter-stage context only via checkpoint files on disk (`/checkpoint/architecture_plan.md`, etc.). No stage writes to `IMemorySystem.store()`. Downstream stages within the same task cannot semantically recall what prior stages produced; subsequent tasks for the same tenant have no access to intra-task reasoning from prior runs | 🟠 High | Each pipeline stage boundary writes a turn summary to STM via `IMemorySystem.store()` using `scope: 'pipeline:{taskId}'`. Stage outputs are summarised by `STMCompressor` into an LTM episodic entry at task end. Downstream stages call `IMemorySystem.recall({ agentScope: 'pipeline:{taskId}', ... })` to access prior-stage context. See §26.5. |
| P-6 | The kilo pipeline is CommonJS and `IMemorySystem` is a TypeScript class in `packages/core-engine`. There is no integration bridge. `memory.js` calls `qdrant.search()` and `embeddings.embed()` directly, bypassing tenant isolation enforcement, `PromptBudgetEnforcer`, composite scoring, deduplication, governance scan, false-positive tracking, and all other guarantees specified in §§2–25 | 🔴 Critical | A `PipelineMemoryAdapter` CJS module wraps `UnifiedMemorySystem` (imported from compiled `core-engine`) and exposes the same async `retrieveMemory(taskId, instruction, tenantId)` interface as the current `memory.js`. The pipeline's `memory.js` is replaced by `PipelineMemoryAdapter`. `IMemorySystem` is initialized once at pipeline startup and held in the DI root alongside existing services. See §26.6. |

---

```typescript
// packages/core-engine/src/agentic/LongTermMemoryStore.ts

import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import type { Plan, DecisionLog } from '@oweibo/core-contracts';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';

// ─── Core Types ───────────────────────────────────────────────────────────────

export type MemoryType =
  | 'successful-strategy'
  | 'failure-pattern'
  | 'tool-heuristic'
  | 'domain-knowledge';
// NOTE: 'user-preference' is intentionally absent. User preferences are facts, not
// episodic observations. They do not belong in LTM (where they would decay, consume
// entry quota, and compete with task memories in vector recall). Preferences are owned
// exclusively by Postgres user_preferences table and loaded via UserProfileStore.

/**
 * MemoryTier — governs decay rate and consolidation eligibility.
 *
 *  episodic   — "what happened in task X"       — fast decay   (7-day  half-life)
 *  semantic   — "what we know is generally true" — slow decay   (90-day half-life)
 *  procedural — "how to do X reliably"           — very slow    (180-day half-life)
 */
export type MemoryTier = 'episodic' | 'semantic' | 'procedural';

/**
 * Memory scope conventions:
 *   'user:{userId}'      — per-user episodic events (e.g. "user completed onboarding").
 *                          NOT used for preferences — those live in Postgres user_preferences.
 *                          Recalled semantically like any other scope.
 *   'project:{projectId}'— project-specific architecture, conventions, decisions
 *                          (recalled with higher boost than tenant-wide memories)
 *   'tenant:{tenantId}'  — tenant-wide shared knowledge (promoted procedural memories)
 *   '{role}:{taskId}'    — agent-role-scoped episodic memories for a specific task
 *   'session:{sessionId}'— crash-recovery LTM write (written by endSession recovery path)
 */
export interface MemoryEntry {
  id: string;
  tenantId: string;           // mandatory — Qdrant collection discriminator
  userId?: string;            // optional — set for user-scoped memories (scope 'user:{userId}')
  projectId?: string;         // optional — set for project-scoped memories (scope 'project:{id}')
  scope: string;              // see scope conventions above
  type: MemoryType;
  tier: MemoryTier;           // controls decay half-life
  summary: string;            // short semantic label — used as vector source
  detail: unknown;            // full structured content
  relevanceTags: string[];    // e.g. ['typescript', 'auth', 'multi-tenant']
  successCount: number;       // incremented by reinforce()
  missCount: number;          // incremented by penalise() — feeds decay score
  confidence: number;         // 0–1: successCount / (successCount + missCount + 1)
  createdAt: number;
  lastAccessedAt: number;
  lastReinforcedAt: number;
  promotedToId?: string;      // set once promoted to prevent double-promotion
  consolidatedAt?: number;    // set by MemoryConsolidator to prevent reprocessing
}

/** Typed recall result — includes composite score for caller-side confidence gating. */
export interface RecallResult {
  entry: MemoryEntry;
  score: number;  // composite: α·cosine + β·recency_boost + γ·success_rate
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LongTermMemoryConfig {
  /** Composite score weights — must sum to 1.0 */
  similarityWeight: number;           // default: 0.60
  recencyWeight: number;              // default: 0.25
  successWeight: number;              // default: 0.15
  recencyHalfLifeDays: number;        // default: 14
  deduplicationThreshold: number;     // default: 0.93
  promotionThreshold: number;         // default: 10 — overridden per-tenant via Vault
  decayEvictionThreshold: number;     // default: 0.05 — entries below this go to archive
  tierHalfLife: Record<MemoryTier, number>;
  enableGovernanceScan: boolean;      // default: true
  maxPointsPerCyclePerTenant: number; // default: 2_000 — Qdrant scroll cap for decay
  batchSize: number;                  // default: 100 — Qdrant scroll page size
  interBatchDelayMs: number;          // default: 50 — back-pressure between batches
  maxConcurrentTenants: number;       // default: 10 — p-limit for background jobs

  /**
   * Hard LLM call budget for MemoryConsolidator per tenant per cycle.
   * Without this cap a tenant with many distinct relevanceTags fires one LLM call
   * per qualifying cluster — unbounded at scale. Clusters are sorted by size
   * (largest first) so the highest-value consolidations always run within the cap.
   * Overridable per-tenant via Vault: oweibo/tenants/{tenantId}/memory/consolidation
   * (alongside windowDays and minClusterSize).
   */
  maxClustersPerCyclePerTenant: number; // default: 20

  /**
   * Hot STM layer: number of most-recent turns kept in-process per (tenantId, sessionId).
   * Recall over this window is a linear cosine scan — zero external I/O beyond embedding.
   * Older turns are evicted from the hot layer (they remain in the warm Redis VSS layer).
   */
  stmHotWindowSize: number;             // default: 50

  /**
   * Warm STM layer: maximum total entries per session in the Redis VSS index.
   * Enforced via atomic INCR on a per-session counter key before each write.
   * StorageCapExceededError is thrown if exceeded; the counter key shares the
   * session TTL so it expires automatically when the session does.
   */
  maxStmEntriesPerSession: number;      // default: 500

  /**
   * Maximum LTM entries per tenant Qdrant collection.
   * Enforced at store() time: if the collection already holds this many points,
   * store() throws LtmCapExceededError instead of upserting. Decay runs nightly
   * and should keep collections well below this ceiling in normal operation;
   * the cap is a hard backstop against runaway episodic writes.
   */
  maxLtmEntriesPerTenant: number;       // default: 100_000

  /**
   * Maximum tokens allocated to the userProfile fixed prompt block.
   * UserProfileStore truncates the rendered profile to this limit before returning.
   * Kept deliberately small — a well-structured profile is 200–500 tokens.
   * This block is always injected and never competes with warmMemory for budget.
   */
  userProfileTokenCap: number;          // default: 600

  /**
   * PreferenceNudgeService config — controls session-end preference detection.
   * Per-tenant overridable via Vault at oweibo/tenants/{tenantId}/memory/nudge.
   */
  nudgeMinConfidence: number;           // default: 0.6 — minimum LLM confidence to write
  nudgeMaxTurns: number;                // default: 20  — max STM turns to review per session
}

export const DEFAULT_LTM_CONFIG: LongTermMemoryConfig = {
  similarityWeight:               0.60,
  recencyWeight:                  0.25,
  successWeight:                  0.15,
  recencyHalfLifeDays:            14,
  deduplicationThreshold:         0.93,
  promotionThreshold:             10,
  decayEvictionThreshold:         0.05,
  tierHalfLife:                   { episodic: 7, semantic: 90, procedural: 180 },
  enableGovernanceScan:           true,
  maxPointsPerCyclePerTenant:     2_000,
  batchSize:                      100,
  interBatchDelayMs:              50,
  maxConcurrentTenants:           10,
  maxClustersPerCyclePerTenant:   20,
  stmHotWindowSize:               50,
  maxStmEntriesPerSession:        500,
  maxLtmEntriesPerTenant:         100_000,
  userProfileTokenCap:            600,
  nudgeMinConfidence:             0.6,
  nudgeMaxTurns:                  20,
};
```

---

## 3. TenantKeyBuilder Extensions

All collection and cache names route through `TenantKeyBuilder`. Raw string templates are
forbidden by the `no-raw-redis-key` ESLint rule enforced in CI.

```typescript
// packages/core-engine/src/infra/TenantKeyBuilder.ts (addendum to existing class)

export class TenantKeyBuilder {
  // ── Existing keys (unchanged) ──────────────────────────────────────────────
  static session(tenantId: string, sessionId: string): string { /* ... */ }
  static ctx(tenantId: string, taskId: string): string { /* ... */ }
  static heartbeat(tenantId: string, taskId: string): string { /* ... */ }

  // ── New LTM / STM keys ─────────────────────────────────────────────────────

  /** LTM Qdrant collection name — one per tenant. */
  static ltmCollection(tenantId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    return `agent-ltm:${tenantId}`;
  }

  /**
   * STM Redis Stack VSS index name — one per tenant, covers all sessions.
   * Created at bootstrap via FT.CREATE with PREFIX = stmEntryPrefix(tenantId).
   * Session isolation is enforced by filtering on the @sessionId TAG field at query time.
   */
  static stmIndex(tenantId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    return `stm-idx:${tenantId}`;
  }

  /**
   * STM entry hash key prefix — used as the FT.CREATE ON HASH PREFIX value.
   * All entry keys for a tenant share this prefix so the per-tenant index
   * covers them without scanning other tenants' keys.
   */
  static stmEntryPrefix(tenantId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    return `stm:${tenantId}:`;
  }

  /** Individual STM entry hash key — one per stored turn. TTL set directly on this key. */
  static stmEntryKey(tenantId: string, sessionId: string, entryId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    TenantKeyBuilder.assertValidSessionId(sessionId);
    return `stm:${tenantId}:${sessionId}:${entryId}`;
  }

  /**
   * Session entry counter key — atomic INCR on every store(); shares the session TTL.
   * Used to enforce maxStmEntriesPerSession without scanning all entry keys.
   */
  static stmCountKey(tenantId: string, sessionId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    TenantKeyBuilder.assertValidSessionId(sessionId);
    return `stm-count:${tenantId}:${sessionId}`;
  }

  /** Skill cache Redis key — moved from SkillRegistry hardcoded string. */
  static skillCache(tenantId: string, repoHash: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    return `skills:cache:${tenantId}:${repoHash}`;
  }

  /**
   * User profile Redis hash key — stores the rendered USER.md content and
   * parsed preference fields for a specific user within a tenant.
   * Loaded by UserProfileStore on demand; cached with a 15-minute TTL.
   */
  static userProfileKey(tenantId: string, userId: string): string {
    TenantKeyBuilder.assertValidTenantId(tenantId);
    if (!userId || /[:/\s'"\\]/.test(userId)) {
      throw new InvalidTenantIdError(`Invalid userId: "${userId}"`);
    }
    return `user-profile:${tenantId}:${userId}`;
  }

  /**
   * Canonical LTM scope string for a user — used when writing user-preference
   * MemoryEntry records. Centralised here so callers never construct scope strings
   * by hand (ESLint enforces this via no-raw-scope-string rule — see below).
   */
  static userScope(userId: string): string {
    if (!userId || /[:/\s'"\\]/.test(userId)) {
      throw new InvalidTenantIdError(`Invalid userId: "${userId}"`);
    }
    return `user:${userId}`;
  }

  /**
   * Canonical LTM scope string for a project — used when writing project-scoped
   * MemoryEntry records. Centralised here for the same ESLint-enforcement reason.
   */
  static projectScope(projectId: string): string {
    if (!projectId || /[:/\s'"\\]/.test(projectId)) {
      throw new InvalidTenantIdError(`Invalid projectId: "${projectId}"`);
    }
    return `project:${projectId}`;
  }

  private static assertValidTenantId(tenantId: string): void {
    if (!tenantId || /[:/\s'"\\]/.test(tenantId)) {
      throw new InvalidTenantIdError(`Invalid tenantId: "${tenantId}"`);
    }
  }

  private static assertValidSessionId(sessionId: string): void {
    if (!sessionId || /[:/\s'"\\]/.test(sessionId)) {
      throw new InvalidTenantIdError(`Invalid sessionId: "${sessionId}"`);
    }
  }
}
```

**ESLint rule — extend `no-raw-redis-key` with new patterns:**

```javascript
// .eslintrc.js
'no-raw-redis-key': ['error', {
  forbiddenPatterns: [
    /agent:ctx:/,
    /hitl:/,
    /heartbeat:/,
    /^session:/,
    /agent-ltm:/,       // must use TenantKeyBuilder.ltmCollection()
    /agent-stm:/,       // legacy pattern — retained to block any stale references
    /stm-idx:/,         // must use TenantKeyBuilder.stmIndex()
    /stm-count:/,       // must use TenantKeyBuilder.stmCountKey()
    /stm:[a-zA-Z0-9]/,  // must use TenantKeyBuilder.stmEntryKey() or stmEntryPrefix()
    /user-profile:/,    // must use TenantKeyBuilder.userProfileKey()
    /skills:cache:/,    // must use TenantKeyBuilder.skillCache()
  ]
}],

// Companion rule blocking raw scope string construction.
// All scope strings must go through TenantKeyBuilder.userScope() / projectScope()
// or use the 'tenant:{id}' / '{role}:{taskId}' literals only in LongTermMemoryStore internals.
'no-raw-scope-string': ['warn', {
  forbiddenPatterns: [
    /`user:\$\{/,       // must use TenantKeyBuilder.userScope(userId)
    /`project:\$\{/,    // must use TenantKeyBuilder.projectScope(projectId)
  ]
}]
```

---

## 4. EmbeddingCache

```typescript
// packages/core-engine/src/agentic/LongTermMemoryStore.ts (internal class)

/**
 * EmbeddingCache — Redis-backed, SHA-256 keyed, 24-hour TTL.
 * Reduces redundant embedding API calls. Typical session hit rate: 60–80%.
 */
class EmbeddingCache {
  private readonly TTL_SECONDS = 86_400;

  constructor(private readonly redis: Redis) {}

  private hashKey(text: string): string {
    const { createHash } = require('crypto');
    return `emb:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
  }

  async get(text: string): Promise<number[] | null> {
    const cached = await this.redis.get(this.hashKey(text));
    if (!cached) return null;
    try { return JSON.parse(cached); } catch { return null; }
  }

  async set(text: string, embedding: number[]): Promise<void> {
    await this.redis.setex(this.hashKey(text), this.TTL_SECONDS, JSON.stringify(embedding));
  }
}
```

---

## 5. LongTermMemoryStore

```typescript
// packages/core-engine/src/agentic/LongTermMemoryStore.ts

export class LongTermMemoryStore {
  private readonly cache: EmbeddingCache;
  private promoter!: MemoryScopePromoter;  // injected post-construction to break circular dep

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embedFn: (text: string) => Promise<number[]>,
    redis: Redis,
    private readonly config: LongTermMemoryConfig = DEFAULT_LTM_CONFIG,
    private readonly secrets?: SecretsManager,
    private readonly tracer?: MemoryTracer,   // gap LTM-8: wired here so recall spans fire
  ) {
    this.cache = new EmbeddingCache(redis);
  }

  /** Set after construction to break the circular LTM ↔ Promoter dependency. */
  setPromoter(promoter: MemoryScopePromoter): void {
    this.promoter = promoter;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    const cached = await this.cache.get(text);
    if (cached) return cached;
    const embedding = await this.embedFn(text);
    await this.cache.set(text, embedding);
    return embedding;
  }

  /**
   * Composite score: α·cosine + β·recency_boost + γ·success_rate
   * recency_boost is exponential half-life relative to the entry's tier.
   * success_rate uses Laplace smoothing: successCount / (successCount + missCount + 1).
   */
  private compositeScore(cosine: number, entry: MemoryEntry): number {
    const { similarityWeight, recencyWeight, successWeight } = this.config;
    const halfLifeDays = this.config.tierHalfLife[entry.tier];
    const ageDays = (Date.now() - entry.lastReinforcedAt) / 86_400_000;
    const recencyBoost = Math.pow(0.5, ageDays / halfLifeDays);
    const total = entry.successCount + entry.missCount + 1;
    const successRate = entry.successCount / total;
    return similarityWeight * cosine + recencyWeight * recencyBoost + successWeight * successRate;
  }

  private async runGovernanceScan(summary: string, detail: unknown): Promise<void> {
    if (!this.config.enableGovernanceScan) return;
    const text = `${summary}\n${JSON.stringify(detail).slice(0, 2_000)}`;
    const suspiciousPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,
      /ghp_[a-zA-Z0-9]{36}/,
      /\b[A-Z0-9]{20}\b.*\b[A-Z0-9]{40}\b/,
      /password\s*[:=]\s*["']?\S+/i,
      /secret\s*[:=]\s*["']?\S+/i,
    ];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(text)) {
        throw new MemoryGovernanceError(
          `Memory content failed governance scan: pattern ${pattern.source.slice(0, 30)}`
        );
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Store a memory entry.
   * Deduplicates: if a near-identical entry exists in the same scope (cosine > threshold),
   * reinforces the existing entry instead of creating a new point.
   * Runs governance scan if enabled.
   */
  async store(
    entry: Omit<MemoryEntry,
      'id' | 'successCount' | 'missCount' | 'confidence' |
      'createdAt' | 'lastAccessedAt' | 'lastReinforcedAt'
    >,
  ): Promise<string> {
    await this.runGovernanceScan(entry.summary, entry.detail);
    const collection = TenantKeyBuilder.ltmCollection(entry.tenantId);

    // Hard entry-count cap — enforced before embedding to avoid wasted API calls.
    // Decay runs nightly and should keep collections well below this ceiling;
    // this is a backstop against runaway writes (e.g. a looping agent, a migration bug).
    const { points_count } = await this.qdrant.getCollection(collection);
    if ((points_count ?? 0) >= this.config.maxLtmEntriesPerTenant) {
      throw new LtmCapExceededError(
        `LTM collection for tenant ${entry.tenantId} has reached the cap of ` +
        `${this.config.maxLtmEntriesPerTenant} entries. Run decay or purge before writing new memories.`
      );
    }

    const vector = await this.embed(entry.summary);

    // Deduplication: near-identical entry in same scope → reinforce instead
    const duplicates = await this.qdrant.search(collection, {
      vector,
      limit: 1,
      with_payload: true,
      score_threshold: this.config.deduplicationThreshold,
      filter: { must: [{ key: 'scope', match: { value: entry.scope } }] },
    });

    if (duplicates.length > 0) {
      const existingId = duplicates[0].id as string;
      await this.reinforce(existingId, entry.tenantId);
      return existingId;
    }

    const id = randomUUID();
    const now = Date.now();
    const full: MemoryEntry = {
      ...entry,
      id,
      successCount: 0,
      missCount: 0,
      confidence: 0,
      createdAt: now,
      lastAccessedAt: now,
      lastReinforcedAt: now,
    };
    await this.qdrant.upsert(collection, { points: [{ id, vector, payload: full }] });
    return id;
  }

  /**
   * Recall memories by composite score. Fetches topK×3 candidates from Qdrant,
   * re-ranks by composite score (cosine + recency + success), returns topK.
   */
  async recall(
    tenantId: string,
    query: string,
    options: {
      types?: MemoryType[];
      tiers?: MemoryTier[];
      scope?: string;
      topK?: number;
      minScore?: number;
    } = {},
  ): Promise<RecallResult[]> {
    const { types, tiers, scope, topK = 5, minScore = 0 } = options;
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const vector = await this.embed(query);

    const must: unknown[] = [{ key: 'tenantId', match: { value: tenantId } }];
    if (types?.length) must.push({ key: 'type', match: { any: types } });
    if (tiers?.length) must.push({ key: 'tier', match: { any: tiers } });
    if (scope)         must.push({ key: 'scope', match: { value: scope } });

    const doRecall = async (): Promise<RecallResult[]> => {
      const raw = await this.qdrant.search(collection, {
        vector,
        limit: topK * 3,
        with_payload: true,
        filter: { must },
      });

      const results = raw
        .map(r => ({
          entry: r.payload as MemoryEntry,
          score: this.compositeScore(r.score, r.payload as MemoryEntry),
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      // Update lastAccessedAt for recalled entries — fire-and-forget so the hot
      // recall path is never blocked. lastAccessedAt is now accurate for analytics
      // and future scoring extensions (gap: lastAccessedAt was tracked but never updated on access).
      if (results.length > 0) {
        const now = Date.now();
        Promise.all(
          results.map(r =>
            this.qdrant.setPayload(collection, {
              payload: { lastAccessedAt: now },
              points: [r.entry.id],
            })
          )
        ).catch(() => { /* non-fatal — access tracking is best-effort */ });
      }

      return results;
    };

    // Emit a Langfuse span when a tracer is wired in (gap LTM-8).
    return this.tracer
      ? this.tracer.traceRecall('ltm', { tenantId, scope, topK }, doRecall)
      : doRecall();
  }

  /** Convenience: scoped recall for BaseAgent. Wraps recall() with scope filter.
   *  minScore and tiers are forwarded so callers can apply the same confidence
   *  gating and tier filtering that raw recall() supports (gap: previously dropped). */
  async recallForAgent(
    tenantId: string,
    memoryScope: string,
    query: string,
    topK = 5,
    minScore = 0,
    tiers?: MemoryTier[],
  ): Promise<RecallResult[]> {
    return this.recall(tenantId, query, { scope: memoryScope, topK, minScore, tiers });
  }

  /**
   * Reinforce: increment successCount. Uses qdrant.setPayload — no re-embedding.
   * Triggers MemoryScopePromoter when successCount crosses the per-tenant threshold.
   */
  async reinforce(memoryId: string, tenantId: string): Promise<void> {
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const [point] = await this.qdrant.retrieve(collection, {
      ids: [memoryId],
      with_payload: true,
    });
    if (!point) return;

    const entry = point.payload as MemoryEntry;
    const newSuccessCount = entry.successCount + 1;
    const newConfidence = newSuccessCount / (newSuccessCount + entry.missCount + 1);

    await this.qdrant.setPayload(collection, {
      payload: {
        successCount: newSuccessCount,
        confidence: newConfidence,
        lastAccessedAt: Date.now(),
        lastReinforcedAt: Date.now(),
      },
      points: [memoryId],
    });

    // Check eligibility for cross-scope promotion
    const threshold = await this.promotionThresholdFor(tenantId);
    if (newSuccessCount >= threshold && this.promoter) {
      await this.promoter.maybePromote(memoryId, { ...entry, successCount: newSuccessCount }, tenantId);
    }
  }

  /**
   * Penalise: increment missCount (recalled but did not help).
   * Reduces confidence score, accelerating decay for consistently unhelpful memories.
   */
  async penalise(memoryId: string, tenantId: string): Promise<void> {
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const [point] = await this.qdrant.retrieve(collection, {
      ids: [memoryId],
      with_payload: true,
    });
    if (!point) return;

    const entry = point.payload as MemoryEntry;
    const newMissCount = entry.missCount + 1;
    const newConfidence = entry.successCount / (entry.successCount + newMissCount + 1);

    await this.qdrant.setPayload(collection, {
      payload: { missCount: newMissCount, confidence: newConfidence, lastAccessedAt: Date.now() },
      points: [memoryId],
    });
  }

  private async promotionThresholdFor(tenantId: string): Promise<number> {
    if (!this.secrets) return this.config.promotionThreshold;
    try {
      const cfg = await this.secrets.getJSON(
        `oweibo/tenants/${tenantId}/memory/promotion-threshold`
      );
      return (cfg as { threshold?: number })?.threshold ?? this.config.promotionThreshold;
    } catch {
      return this.config.promotionThreshold;
    }
  }
}
```

---

## 6. ShortTermMemoryStore

```typescript
// packages/core-engine/src/agentic/ShortTermMemoryStore.ts
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';
import type { LongTermMemoryConfig } from './LongTermMemoryStore';

/**
 * ShortTermMemoryStore — two-layer session memory.
 *
 * HOT layer — in-process Map, zero external I/O beyond embedding.
 *   Holds the most recent `stmHotWindowSize` turns per (tenantId, sessionId).
 *   Recall is a linear cosine scan: O(N) at N ≤ stmHotWindowSize — microseconds.
 *   Ephemeral: lost on worker restart. Worker-restart resilience comes from
 *   DistributedContextStore persisting raw turn text; STM semantic recall degrades
 *   gracefully to warm-layer quality on the first turn post-restart.
 *
 * WARM layer — Redis Stack HNSW vector index with native per-entry TTL.
 *   One VSS index per tenant (FT.CREATE stm-idx:{tenantId}), covering all sessions.
 *   Session isolation via @sessionId TAG filter on FT.SEARCH — no per-session index.
 *   Tenant isolation via per-tenant index and key prefix — cross-tenant queries
 *   are structurally impossible.
 *   Individual entries stored as Redis hashes: stm:{tenantId}:{sessionId}:{entryId}.
 *   TTL set directly on each hash key — no separate tracking key, no reaper.
 *   Requires Redis Stack (redis-stack-server or Redis Cloud with Search module).
 *   Falls back gracefully to empty warm results on plain Redis deployments.
 *
 * Entry count cap: maxStmEntriesPerSession entries per session enforced via atomic
 * INCR on stm-count:{tenantId}:{sessionId}. Counter key shares the session TTL.
 *
 * Key routing — all through TenantKeyBuilder, ESLint-enforced:
 *   VSS index : TenantKeyBuilder.stmIndex(tenantId)
 *   Entry key : TenantKeyBuilder.stmEntryKey(tenantId, sessionId, entryId)
 *   Counter   : TenantKeyBuilder.stmCountKey(tenantId, sessionId)
 *
 * TTL: per-tenant via Vault at oweibo/tenants/{tenantId}/memory/stm-ttl-seconds (default 3600).
 */
export interface STMEntry {
  id: string;
  tenantId: string;
  userId?: string;    // optional — propagated from task context; enables per-user session recall
  sessionId: string;
  turnIndex: number;
  role: 'agent' | 'tool' | 'user';
  summary: string;
  detail: unknown;
  tags: string[];
  createdAt: number;
}

export interface STMRecallResult {
  entry: STMEntry;
  score: number;
}

export class ShortTermMemoryStore {
  private readonly VECTOR_SIZE   = 1536;
  private readonly DEFAULT_TTL   = 3_600;

  /** Hot layer: in-process embeddings, keyed by `${tenantId}:${sessionId}`. */
  private readonly hotLayer = new Map<string, Array<{ embedding: number[]; entry: STMEntry }>>();

  constructor(
    private readonly redis: Redis,
    private readonly embedFn: (text: string) => Promise<number[]>,
    private readonly config: Pick<LongTermMemoryConfig, 'stmHotWindowSize' | 'maxStmEntriesPerSession'>,
    private readonly secrets?: SecretsManager,
  ) {}

  // ── Private helpers ──────────────────────────────────────────────────────────

  private hotKey(tenantId: string, sessionId: string): string {
    return `${tenantId}:${sessionId}`;
  }

  private async ttlFor(tenantId: string): Promise<number> {
    if (!this.secrets) return this.DEFAULT_TTL;
    try {
      const cfg = await this.secrets.getJSON(
        `oweibo/tenants/${tenantId}/memory/stm-ttl-seconds`
      );
      return (cfg as { ttl?: number })?.ttl ?? this.DEFAULT_TTL;
    } catch {
      return this.DEFAULT_TTL;
    }
  }

  /** Pack float32 embedding array into a little-endian Buffer for Redis VSS HNSW. */
  private packEmbedding(embedding: number[]): Buffer {
    const buf = Buffer.allocUnsafe(embedding.length * 4);
    for (let i = 0; i < embedding.length; i++) buf.writeFloatLE(embedding[i], i * 4);
    return buf;
  }

  /** Linear cosine similarity for hot-layer scan. */
  private cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Upsert a new entry into the hot layer; evict oldest if window is full. */
  private hotStore(tenantId: string, sessionId: string, embedding: number[], entry: STMEntry): void {
    const k = this.hotKey(tenantId, sessionId);
    if (!this.hotLayer.has(k)) this.hotLayer.set(k, []);
    const window = this.hotLayer.get(k)!;
    window.push({ embedding, entry });
    if (window.length > this.config.stmHotWindowSize) {
      window.shift(); // evict oldest; entry remains in warm Redis layer
    }
  }

  /** Linear cosine scan of the hot layer for this session. */
  private hotRecall(
    tenantId: string,
    sessionId: string,
    queryEmbedding: number[],
    topK: number,
    minScore: number,
  ): STMRecallResult[] {
    const window = this.hotLayer.get(this.hotKey(tenantId, sessionId)) ?? [];
    return window
      .map(({ embedding, entry }) => ({ entry, score: this.cosine(queryEmbedding, embedding) }))
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** FT.SEARCH over the warm Redis VSS index for this tenant+session. */
  private async warmRecall(
    tenantId: string,
    sessionId: string,
    queryEmbedding: number[],
    topK: number,
    minScore: number,
  ): Promise<STMRecallResult[]> {
    const indexName = TenantKeyBuilder.stmIndex(tenantId);
    const blob      = this.packEmbedding(queryEmbedding);
    try {
      // FT.SEARCH with KNN + session TAG filter (Redis Stack DIALECT 2)
      const raw = await (this.redis as unknown as { call(...args: unknown[]): Promise<unknown> }).call(
        'FT.SEARCH', indexName,
        `@sessionId:{${sessionId.replace(/[-]/g, '\\-')}} =>[KNN ${topK * 3} @embedding $BLOB AS __score]`,
        'SORTBY', '__score',
        'PARAMS', '2', 'BLOB', blob,
        'RETURN', '8', 'tenantId', 'sessionId', 'turnIndex', 'role', 'summary', 'detail', 'tags', 'createdAt',
        'DIALECT', '2',
        'LIMIT', '0', String(topK * 3),
      ) as unknown[];

      // Redis returns [total, key1, fields1, key2, fields2, ...]
      const results: STMRecallResult[] = [];
      for (let i = 1; i < raw.length; i += 2) {
        const fields = raw[i + 1] as string[];
        const fieldMap: Record<string, string> = {};
        for (let j = 0; j < fields.length; j += 2) fieldMap[fields[j]] = fields[j + 1];
        // __score is cosine distance (0 = identical); convert to similarity
        const scoreField = (raw[i] as string).match(/__score:([\d.]+)/)?.[1];
        const cosineDistance = scoreField ? parseFloat(scoreField) : 1;
        const score = 1 - cosineDistance;
        if (score < minScore) continue;
        const entry: STMEntry = {
          id:        (raw[i] as string).split(':').pop() ?? '',
          tenantId:  fieldMap['tenantId']  ?? tenantId,
          sessionId: fieldMap['sessionId'] ?? sessionId,
          turnIndex: Number(fieldMap['turnIndex'] ?? 0),
          role:      (fieldMap['role'] ?? 'agent') as STMEntry['role'],
          summary:   fieldMap['summary']  ?? '',
          detail:    JSON.parse(fieldMap['detail']  ?? 'null'),
          tags:      JSON.parse(fieldMap['tags']    ?? '[]'),
          createdAt: Number(fieldMap['createdAt']   ?? 0),
        };
        results.push({ entry, score });
      }
      return results.sort((a, b) => b.score - a.score).slice(0, topK);
    } catch {
      // Index absent (plain Redis, or first-run before ensureStmIndices) — degrade gracefully
      return [];
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async store(entry: Omit<STMEntry, 'id' | 'createdAt'>): Promise<string> {
    const ttl = await this.ttlFor(entry.tenantId);
    const countKey = TenantKeyBuilder.stmCountKey(entry.tenantId, entry.sessionId);

    // Atomic increment then check — single round-trip, no race window
    const count = await this.redis.incr(countKey);
    await this.redis.expire(countKey, ttl);
    if (count > this.config.maxStmEntriesPerSession) {
      // Decrement to avoid permanently locking the session on repeated attempts
      await this.redis.decr(countKey);
      throw new StorageCapExceededError(
        `STM session ${entry.sessionId} for tenant ${entry.tenantId} has reached the ` +
        `cap of ${this.config.maxStmEntriesPerSession} entries.`
      );
    }

    const id        = randomUUID();
    const embedding = await this.embedFn(entry.summary);
    const full: STMEntry = { ...entry, id, createdAt: Date.now() };

    // ── Warm layer write ─────────────────────────────────────────────────────
    const entryKey = TenantKeyBuilder.stmEntryKey(entry.tenantId, entry.sessionId, id);
    await this.redis.hset(entryKey,
      'tenantId',  entry.tenantId,
      'sessionId', entry.sessionId,
      'turnIndex', String(entry.turnIndex),
      'role',      entry.role,
      'summary',   entry.summary,
      'detail',    JSON.stringify(entry.detail),
      'tags',      JSON.stringify(entry.tags),
      'createdAt', String(full.createdAt),
      'embedding', this.packEmbedding(embedding),
    );
    await this.redis.expire(entryKey, ttl);

    // ── Hot layer write ──────────────────────────────────────────────────────
    this.hotStore(entry.tenantId, entry.sessionId, embedding, full);

    return id;
  }

  async recall(
    tenantId: string,
    sessionId: string,
    query: string,
    topK = 5,
    minScore = 0.35,
  ): Promise<STMRecallResult[]> {
    const queryEmbedding = await this.embedFn(query);

    // Hot layer first — linear scan, microseconds, no I/O
    const hotResults = this.hotRecall(tenantId, sessionId, queryEmbedding, topK, minScore);

    // Warm layer fills remaining slots — only called if hot results are insufficient
    if (hotResults.length >= topK) return hotResults;

    const warmResults = await this.warmRecall(tenantId, sessionId, queryEmbedding, topK, minScore);

    // Merge: deduplicate by id (hot layer entries are a subset of warm layer),
    // keep hot-layer copy (embedding already loaded in-process).
    const hotIds = new Set(hotResults.map(r => r.entry.id));
    const merged = [
      ...hotResults,
      ...warmResults.filter(r => !hotIds.has(r.entry.id)),
    ].sort((a, b) => b.score - a.score).slice(0, topK);

    return merged;
  }

  async destroySession(tenantId: string, sessionId: string): Promise<void> {
    // Evict hot layer
    this.hotLayer.delete(this.hotKey(tenantId, sessionId));

    // Delete counter key
    await this.redis.del(TenantKeyBuilder.stmCountKey(tenantId, sessionId));

    // Scan and delete all warm-layer entry hashes for this session.
    // SCAN is safe here: destroySession is called at session end, not in hot paths.
    const prefix = TenantKeyBuilder.stmEntryKey(tenantId, sessionId, '');
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      if (keys.length > 0) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }

  /**
   * Scroll all warm-layer entries for a session — used by UnifiedMemorySystem.endSession()
   * crash-recovery path. Hot layer is not consulted (it may be empty after a restart).
   * Returns an empty array if no entries exist (session never created or already torn down).
   */
  async scrollSession(tenantId: string, sessionId: string): Promise<STMEntry[]> {
    const prefix = TenantKeyBuilder.stmEntryKey(tenantId, sessionId, '');
    const results: STMEntry[] = [];
    let cursor = '0';
    try {
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        for (const key of keys) {
          const fields = await this.redis.hgetall(key);
          if (!fields || !fields['summary']) continue;
          results.push({
            id:        key.split(':').pop() ?? '',
            tenantId:  fields['tenantId']  ?? tenantId,
            sessionId: fields['sessionId'] ?? sessionId,
            turnIndex: Number(fields['turnIndex'] ?? 0),
            role:      (fields['role'] ?? 'agent') as STMEntry['role'],
            summary:   fields['summary']  ?? '',
            detail:    JSON.parse(fields['detail']  ?? 'null'),
            tags:      JSON.parse(fields['tags']    ?? '[]'),
            createdAt: Number(fields['createdAt']   ?? 0),
          });
        }
        cursor = next;
      } while (cursor !== '0');
    } catch {
      // Redis unavailable — return partial results
    }
    return results.sort((a, b) => a.turnIndex - b.turnIndex);
  }
}
```

---

## 6a. UserProfileStore

```typescript
// packages/core-engine/src/agentic/UserProfileStore.ts
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { ModelRouter } from '../routing/ModelRouter';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';

/**
 * UserProfileStore — loads, caches, and renders per-user profile data.
 *
 * SEPARATION OF CONCERNS
 * ──────────────────────
 * Three memory classes are kept strictly separate so they never compete for
 * the same prompt-budget pool:
 *
 *   1. userProfile  — always injected, fixed block, never semantic-recalled.
 *                     Source of truth: Postgres (user_profiles + user_preferences).
 *                     Cache: Redis hash, per-tenant TTL.
 *
 *   2. projectMemory — semantically recalled, project-scoped LTM.
 *
 *   3. tenantMemory  — semantically recalled, tenant-wide promoted procedures.
 *
 * CANONICAL OWNERSHIP
 * ───────────────────
 * Postgres is the sole canonical owner of all preference data.
 *
 * The previous design had three simultaneous owners (Postgres, LTM, Redis) with
 * no single write contract. The concrete bug: upsertPreference() wrote to LTM,
 * but loadProfile() returned early from Postgres and never read those LTM entries.
 * Preferences accumulated in LTM, consumed entry quota, decayed over time, and
 * were silently ignored for any user with an existing Postgres row.
 *
 * The fix: user-preference is removed from MemoryType entirely. Preferences are
 * stored in a normalised Postgres table (user_preferences) via UPSERT ON CONFLICT.
 * loadProfile() is Redis → Postgres only — two tiers, no embedding call, no LTM.
 * UserProfileStore no longer depends on LongTermMemoryStore.
 *
 * SCHEMA
 * ──────
 * user_profiles   (tenant_id, user_id) → JSONB content (display name, format, etc.)
 * user_preferences (tenant_id, user_id, key) → value, confidence  [UNIQUE on key]
 *
 * PREFERENCE DETECTION
 * ────────────────────
 * UserProfileStore does not detect preferences itself — it only persists them.
 * Preference signals are detected by PreferenceNudgeService (§6b), which runs at
 * session end, reviews recent STM turns via an LLM pass, and calls upsertPreference()
 * for any signals it finds above the confidence threshold.
 *
 * SEE ALSO: §6b PreferenceNudgeService, §0.4 Write paths
 *
 * VAULT
 * ─────
 * oweibo/tenants/{tenantId}/memory/user-profile-ttl-seconds (default 900)
 */
export interface UserProfile {
  userId: string;
  tenantId: string;
  displayName?: string;
  preferredOutputFormat?: 'concise' | 'verbose' | 'structured';
  skillLevel?: 'beginner' | 'intermediate' | 'expert';
  communicationStyle?: 'formal' | 'casual';
  timezone?: string;
  language?: string;
  /** Free-form preferences written by agents via upsertPreference(). */
  preferences: Array<{ key: string; value: string; confidence: number }>;
  updatedAt: number;
}

export class UserProfileStore {
  private readonly DEFAULT_CACHE_TTL = 900;  // 15 minutes

  constructor(
    private readonly pg: Pool,
    private readonly redis: Redis,
    private readonly modelRouter: ModelRouter,
    private readonly userProfileTokenCap: number = 600,
  ) {}

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async cacheTtl(tenantId: string): Promise<number> {
    try {
      const raw = await this.redis.get(`oweibo:${tenantId}:user-profile-ttl`);
      return raw ? Number(raw) : this.DEFAULT_CACHE_TTL;
    } catch {
      return this.DEFAULT_CACHE_TTL;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Load a user's full profile: Redis cache → Postgres.
   *
   * Two tiers only — no LTM fallback, no embedding call. Preferences come from
   * the normalised user_preferences table joined at the Postgres layer.
   *
   * Returns null for a brand-new user with no Postgres rows yet.
   */
  async loadProfile(tenantId: string, userId: string): Promise<UserProfile | null> {
    const cacheKey = TenantKeyBuilder.userProfileKey(tenantId, userId);

    // 1. Redis cache — hot path, sub-millisecond
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as UserProfile;
    } catch { /* cache miss — fall through */ }

    // 2. Postgres — single query joining profile + preferences
    const { rows } = await this.pg.query<{
      content: Omit<UserProfile, 'userId' | 'tenantId' | 'preferences' | 'updatedAt'>;
      updated_at: Date;
      pref_key: string | null;
      pref_value: string | null;
      pref_confidence: number | null;
    }>(
      `SELECT
         p.content,
         p.updated_at,
         pr.key   AS pref_key,
         pr.value AS pref_value,
         pr.confidence AS pref_confidence
       FROM user_profiles p
       LEFT JOIN user_preferences pr
         ON pr.tenant_id = p.tenant_id AND pr.user_id = p.user_id
       WHERE p.tenant_id = $1 AND p.user_id = $2
       ORDER BY pr.confidence DESC NULLS LAST`,
      [tenantId, userId],
    );

    if (rows.length === 0) return null;

    const first = rows[0];
    const profile: UserProfile = {
      userId,
      tenantId,
      ...first.content,
      preferences: rows
        .filter(r => r.pref_key !== null)
        .map(r => ({
          key:        r.pref_key!,
          value:      r.pref_value!,
          confidence: r.pref_confidence!,
        })),
      updatedAt: first.updated_at.getTime(),
    };

    // Populate Redis cache
    const ttl = await this.cacheTtl(tenantId);
    await this.redis.setex(cacheKey, ttl, JSON.stringify(profile)).catch(() => {});

    return profile;
  }

  /**
   * Write or update a single user preference.
   *
   * Uses UPSERT ON CONFLICT (tenant_id, user_id, key) so agents can safely call this
   * repeatedly as they detect preference signals — no duplicates, last write wins on
   * value, highest confidence wins via MAX in the update expression.
   *
   * Invalidates the Redis cache so the next loadProfile() reflects the change.
   * Does NOT touch LTM — preferences are facts, not episodic observations.
   */
  async upsertPreference(
    tenantId: string,
    userId: string,
    key: string,
    value: string,
    confidence = 1.0,
  ): Promise<void> {
    await this.pg.query(
      `INSERT INTO user_preferences (tenant_id, user_id, key, value, confidence, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tenant_id, user_id, key)
       DO UPDATE SET
         value      = EXCLUDED.value,
         confidence = GREATEST(user_preferences.confidence, EXCLUDED.confidence),
         updated_at = NOW()`,
      [tenantId, userId, key, value, confidence],
    );
    // Invalidate cache — next loadProfile() will re-read from Postgres
    await this.redis.del(TenantKeyBuilder.userProfileKey(tenantId, userId)).catch(() => {});
  }

  /**
   * Upsert structured profile fields (display name, output format, etc.).
   * Merges the provided fields into the existing JSONB content column.
   * Invalidates the Redis cache.
   */
  async upsertProfileFields(
    tenantId: string,
    userId: string,
    fields: Partial<Omit<UserProfile, 'userId' | 'tenantId' | 'preferences' | 'updatedAt'>>,
  ): Promise<void> {
    await this.pg.query(
      `INSERT INTO user_profiles (tenant_id, user_id, content, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET
         content    = user_profiles.content || EXCLUDED.content,
         updated_at = NOW()`,
      [tenantId, userId, JSON.stringify(fields)],
    );
    await this.redis.del(TenantKeyBuilder.userProfileKey(tenantId, userId)).catch(() => {});
  }

  /**
   * Render a UserProfile to a structured XML block for prompt injection.
   * Truncated to userProfileTokenCap tokens before returning.
   * Returns '' for null profiles (new user — no block injected).
   *
   * Example output:
   *   <user_profile>
   *     <display_name>Alice</display_name>
   *     <preferred_output>concise</preferred_output>
   *     <skill_level>expert</skill_level>
   *     <preference key="language">TypeScript over JavaScript</preference>
   *     <preference key="format">bullet points, not paragraphs</preference>
   *   </user_profile>
   */
  renderProfile(profile: UserProfile | null): string {
    if (!profile) return '';

    const lines: string[] = ['<user_profile>'];
    if (profile.displayName)           lines.push(`  <display_name>${profile.displayName}</display_name>`);
    if (profile.preferredOutputFormat) lines.push(`  <preferred_output>${profile.preferredOutputFormat}</preferred_output>`);
    if (profile.skillLevel)            lines.push(`  <skill_level>${profile.skillLevel}</skill_level>`);
    if (profile.communicationStyle)    lines.push(`  <communication_style>${profile.communicationStyle}</communication_style>`);
    if (profile.timezone)              lines.push(`  <timezone>${profile.timezone}</timezone>`);
    if (profile.language)              lines.push(`  <language>${profile.language}</language>`);
    for (const pref of profile.preferences.filter(p => p.confidence >= 0.5)) {
      lines.push(`  <preference key="${pref.key}">${pref.value}</preference>`);
    }
    lines.push('</user_profile>');

    const raw = lines.join('\n');
    if (this.modelRouter.countTokens(raw) <= this.userProfileTokenCap) return raw;

    // Binary-search truncation: drop lowest-confidence preferences until it fits
    let filtered = [...profile.preferences].sort((a, b) => b.confidence - a.confidence);
    while (filtered.length > 0) {
      filtered = filtered.slice(0, filtered.length - 1);
      const truncated = this.renderProfile({ ...profile, preferences: filtered });
      if (this.modelRouter.countTokens(truncated) <= this.userProfileTokenCap) return truncated;
    }
    return '';
  }
}
```

---

## 6b. PreferenceNudgeService

```typescript
// packages/core-engine/src/agentic/PreferenceNudgeService.ts
import type { ShortTermMemoryStore } from './ShortTermMemoryStore';
import type { UserProfileStore } from './UserProfileStore';
import type { ModelRouter } from '../routing/ModelRouter';
import type { ILLMClient } from '@oweibo/core-contracts';
import type { Logger } from '../infra/Logger';
import type { PrometheusClient } from '../infra/PrometheusClient';

/**
 * PreferenceNudgeService — session-end preference signal detection.
 *
 * MOTIVATION
 * ──────────
 * UserProfileStore.upsertPreference() exists but nothing calls it automatically.
 * Without a detection mechanism, preferences only accumulate if application code
 * explicitly recognises and writes them — which means they never accumulate in
 * practice. PreferenceNudgeService closes this gap by reviewing session turns at
 * the end of every session and extracting any preference signals the user expressed.
 *
 * DESIGN
 * ──────
 * Runs at session end, AFTER the last agent turn and BEFORE endSession() tears down
 * STM. This ordering is critical: STM warm-layer entries must still be intact when
 * the nudge runs so scrollSession() can read them.
 *
 * Call order in ConversationalLoop.run():
 *   last turn → nudgeAfterSession() → memorySystem.endSession()
 *
 * The nudge reads the last maxTurns STM entries for the session, formats them as
 * a turn transcript, and asks the small model whether the user expressed any
 * preference signals. Detected signals above minConfidence are written via
 * UserProfileStore.upsertPreference() to Postgres — the sole canonical store.
 *
 * NON-FATAL
 * ─────────
 * Any error in the nudge pipeline (LLM timeout, Redis unavailable, Postgres write
 * failure) is caught, logged, and counted by metric. It does NOT propagate — session
 * teardown must never be blocked by preference detection. Preferences are a
 * best-effort enhancement, not a correctness requirement.
 *
 * EVIDENCE THRESHOLD
 * ──────────────────
 * The LLM prompt instructs the model to assign confidence based on evidence strength:
 *   0.9–1.0 : explicit user statement ("I prefer...", "always use...", "stop...")
 *   0.6–0.8 : repeated implicit signal across multiple turns
 *   < 0.6   : not reported by model; filtered before upsertPreference() if it slips through
 *
 * The model is also instructed not to infer from a single casual mention.
 *
 * METRICS
 * ───────
 *   oweibo_preference_nudge_sessions_total{tenant_id}  — sessions where nudge ran
 *   oweibo_preference_nudge_signals_total{tenant_id}   — signals written to Postgres
 *   oweibo_preference_nudge_errors_total{tenant_id}    — non-fatal errors
 *
 * SEE ALSO: §0.4 Write paths, §6a UserProfileStore, §19 ConversationalLoop
 */

const NUDGE_SYSTEM_PROMPT = `\
You are a preference detector for an AI coding agent system.

You will receive a list of conversation turns from a session. Your job is to identify
any explicit or repeated user signals about working preferences, such as:
- Preferred output format (concise, verbose, structured, bullet points, prose)
- Preferred programming language or framework (e.g. "TypeScript over JavaScript")
- Communication style (formal or casual)
- Recurring feedback patterns (always asks for X, repeatedly rejects Y)
- Any other stable working preference the user expressed

RULES:
- Only report signals that appear in at least 2 turns OR are stated very explicitly
  once with clear intent (e.g. "I always want...", "please stop...", "from now on...")
- Set confidence 0.9-1.0 for explicit statements, 0.6-0.8 for repeated implicit signals
- Do NOT infer from a single casual mention
- The "evidence" field must quote or paraphrase the specific turn(s) that show the signal
- Return ONLY valid JSON — no prose, no markdown fences, no preamble
- Schema: { "signals": [{ "key": string, "value": string, "evidence": string, "confidence": number }] }
- Return { "signals": [] } if no clear preference signals are detected`;

export interface NudgeSignal {
  key: string;
  value: string;
  evidence: string;
  confidence: number;
}

export interface NudgeConfig {
  minConfidence: number;   // default 0.6
  maxTurns: number;        // default 20
}

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  minConfidence: 0.6,
  maxTurns:      20,
};

export class PreferenceNudgeService {
  constructor(
    private readonly stm: ShortTermMemoryStore,
    private readonly userProfileStore: UserProfileStore,
    private readonly modelRouter: ModelRouter,
    private readonly llmFactory: (modelId: string) => ILLMClient,
    private readonly logger: Logger,
    private readonly metrics: PrometheusClient,
    private readonly config: NudgeConfig = DEFAULT_NUDGE_CONFIG,
  ) {}

  /**
   * Run preference detection for a completed session.
   *
   * Safe to call when userId is undefined — returns 0 immediately (system sessions
   * have no user to detect preferences for).
   * Non-fatal: any internal error is caught, logged, and counted.
   *
   * @returns number of preference signals written to Postgres (0 on error or no signals)
   */
  async nudgeAfterSession(
    tenantId: string,
    userId: string | undefined,
    sessionId: string,
  ): Promise<number> {
    if (!userId) return 0;
    try {
      return await this.runNudge(tenantId, userId, sessionId);
    } catch (err) {
      this.logger.error('[PreferenceNudgeService] non-fatal error during nudge', {
        tenantId, userId, sessionId, err,
      });
      this.metrics.increment('oweibo_preference_nudge_errors_total', { tenant_id: tenantId });
      return 0;
    }
  }

  private async runNudge(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<number> {
    // 1. Read all warm-layer STM entries for this session (hot layer may be empty
    //    if the worker restarted mid-session; warm layer is the reliable source)
    const allEntries = await this.stm.scrollSession(tenantId, sessionId);
    if (allEntries.length === 0) return 0;

    // Take only the last maxTurns entries — older turns are less reliable signal.
    // Filter to user + agent roles; tool outputs are not preference signals.
    const entries = allEntries
      .slice(-this.config.maxTurns)
      .filter(e => e.role === 'user' || e.role === 'agent');

    // Minimum viable context: at least 2 turns to detect a "repeated" signal
    if (entries.length < 2) return 0;

    // 2. Format turns as a numbered transcript for the LLM
    const turnText = entries
      .map((e, i) => `[Turn ${i + 1} | ${e.role}] ${e.summary}`)
      .join('\n');

    // 3. Call small model — preference detection does not need a large model
    const modelId = await this.modelRouter.selectModel('summarization');
    const llm     = this.llmFactory(modelId);

    const result = await llm.generate({
      systemPrompt:   NUDGE_SYSTEM_PROMPT,
      userPrompt:     `Session turns:\n\n${turnText}`,
      responseFormat: 'json',
    });

    // 4. Parse response — treat any malformed output as zero signals (non-fatal)
    let parsed: { signals: NudgeSignal[] };
    try {
      parsed = JSON.parse(result.output);
      if (!Array.isArray(parsed?.signals)) throw new Error('Invalid schema');
    } catch {
      this.logger.warn('[PreferenceNudgeService] malformed LLM output — skipping', {
        tenantId, userId, sessionId,
      });
      return 0;
    }

    // 5. Filter: confidence threshold, required fields, non-empty evidence
    const qualifying = parsed.signals.filter(s =>
      typeof s.key === 'string'        && s.key.length > 0 &&
      typeof s.value === 'string'      && s.value.length > 0 &&
      typeof s.confidence === 'number' && s.confidence >= this.config.minConfidence &&
      typeof s.evidence === 'string'   && s.evidence.length > 0
    );

    this.metrics.increment('oweibo_preference_nudge_sessions_total', { tenant_id: tenantId });

    if (qualifying.length === 0) return 0;

    // 6. Write qualifying signals to Postgres via UserProfileStore — sole canonical store.
    //    UPSERT ON CONFLICT (tenant_id, user_id, key) with GREATEST(confidence) means
    //    repeated detection of the same preference raises its confidence over time.
    await Promise.all(
      qualifying.map(s =>
        this.userProfileStore.upsertPreference(
          tenantId, userId, s.key, s.value, s.confidence,
        )
      )
    );

    this.metrics.increment('oweibo_preference_nudge_signals_total', {
      tenant_id: tenantId,
    });
    this.logger.info('[PreferenceNudgeService] preference signals written', {
      tenantId, userId, sessionId,
      count:   qualifying.length,
      signals: qualifying.map(s => ({ key: s.key, confidence: s.confidence })),
    });

    return qualifying.length;
  }
}
```

**Wire-up — construction at DI root (alongside UserProfileStore):**

```typescript
// packages/core-engine/src/main.ts (or AgentFactory)

const preferenceNudge = new PreferenceNudgeService(
  stm,               // ShortTermMemoryStore — reads session turns via scrollSession()
  userProfileStore,  // UserProfileStore     — writes detected signals to Postgres
  modelRouter,       // selects small model for the detection LLM call
  llmFactory,
  logger,
  metrics,
  {
    minConfidence: config.nudgeMinConfidence ?? DEFAULT_NUDGE_CONFIG.minConfidence,
    maxTurns:      config.nudgeMaxTurns      ?? DEFAULT_NUDGE_CONFIG.maxTurns,
  },
);
```

**Vault config** (per-tenant overrides at `oweibo/tenants/{tenantId}/memory/nudge`):

```jsonc
// Higher threshold for high-noise tenants; more turns for longer sessions
{ "minConfidence": 0.7, "maxTurns": 30 }
```

---
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { Pool } from 'pg';
import pLimit from 'p-limit';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';
import type { MemoryEntry, MemoryTier, LongTermMemoryConfig } from './LongTermMemoryStore';

/**
 * MemoryDecayService — the agent's "forgetting curve".
 *
 * Runs daily as a K8s CronJob (03:00 UTC). Applies per-tier exponential decay:
 *   effective_confidence = confidence × e^(−λ × days_since_last_reinforcement)
 *   where λ = ln(2) / tier_half_life_days
 *
 * Entries below decayEvictionThreshold → archived to Postgres ltm_archive, deleted from Qdrant.
 * Entries above threshold → confidence updated in-place via setPayload.
 *
 * Scalability: processes at most maxPointsPerCyclePerTenant per tenant per cycle.
 * Uses async generator scrolling with inter-batch delay to avoid Qdrant saturation.
 * Tenant concurrency is p-limited to maxConcurrentTenants.
 */
export class MemoryDecayService {
  constructor(
    private readonly qdrant: QdrantClient,
    private readonly pg: Pool,
    private readonly config: LongTermMemoryConfig,
    private readonly tenantIds: () => Promise<string[]>,
    private readonly logger: Logger,
  ) {}

  async runDecayCycle(): Promise<void> {
    const tenants = await this.tenantIds();
    const limit = pLimit(this.config.maxConcurrentTenants);
    await Promise.all(tenants.map(tid => limit(() => this.decayTenant(tid))));
  }

  private async decayTenant(tenantId: string): Promise<void> {
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const now = Date.now();
    let processedCount = 0;

    for await (const batch of this.scrollBatches(collection)) {
      if (processedCount >= this.config.maxPointsPerCyclePerTenant) {
        this.logger.info(`[MemoryDecay] ${tenantId}: cap at ${processedCount} — deferring remainder`);
        break;
      }

      const toArchive: MemoryEntry[] = [];
      const toUpdate: Array<{ id: string; confidence: number }> = [];

      for (const point of batch) {
        const entry = point.payload as MemoryEntry;
        const halfLifeDays = this.config.tierHalfLife[entry.tier as MemoryTier] ?? 14;
        const lambda = Math.LN2 / halfLifeDays;
        const ageDays = (now - entry.lastReinforcedAt) / 86_400_000;
        const effectiveConfidence = entry.confidence * Math.exp(-lambda * ageDays);

        if (effectiveConfidence < this.config.decayEvictionThreshold) {
          toArchive.push(entry);
        } else {
          toUpdate.push({ id: point.id as string, confidence: effectiveConfidence });
        }
      }

      if (toArchive.length > 0) {
        await this.archiveEntries(toArchive);
        await this.qdrant.delete(collection, { points: toArchive.map(e => e.id) });
      }

      for (const { id, confidence } of toUpdate) {
        await this.qdrant.setPayload(collection, { payload: { confidence }, points: [id] });
      }

      processedCount += batch.length;
      await new Promise(r => setTimeout(r, this.config.interBatchDelayMs));
    }
  }

  private async *scrollBatches(collection: string): AsyncGenerator<QdrantPoint[]> {
    let offset: string | undefined;
    do {
      const page = await this.qdrant.scroll(collection, {
        limit: this.config.batchSize,
        offset,
        with_payload: true,
        with_vector: false,
      });
      yield page.points;
      offset = page.next_page_offset as string | undefined;
    } while (offset);
  }

  private async archiveEntries(entries: MemoryEntry[]): Promise<void> {
    // Parameterized bulk insert — safe against all Postgres injection vectors regardless
    // of summary or detail content. Each entry occupies 7 parameters; placeholders are
    // $1…$(7n). ON CONFLICT DO NOTHING preserves idempotency across retried decay cycles.
    const placeholders: string[] = [];
    const values: unknown[] = [];
    entries.forEach((e, i) => {
      const base = i * 7;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, NOW())`
      );
      values.push(e.id, e.tenantId, e.scope, e.type, e.tier, e.summary, JSON.stringify(e.detail));
    });

    await this.pg.query(
      `INSERT INTO ltm_archive (id, tenant_id, scope, type, tier, summary, detail, archived_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      values,
    );
  }
}
```

---

## 8. MemoryScopePromoter

```typescript
// packages/core-engine/src/agentic/MemoryScopePromoter.ts
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { LongTermMemoryStore, MemoryEntry } from './LongTermMemoryStore';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';

/**
 * MemoryScopePromoter — graduates high-value role-scoped heuristics to shared tenant scope.
 *
 * Promotion rules:
 *   - Source scope must be role-scoped: '{role}:{taskId}' — not already a tenant scope.
 *   - Target scope: 'tenant:{tenantId}' — readable by all agents for this tenant.
 *   - Promoted tier is always 'procedural' — durable institutional knowledge.
 *   - Original entry is NOT deleted — preserved for agent memory isolation.
 *   - 'promotedToId' is set on the original to prevent double-promotion.
 *   - Promotion threshold is per-tenant, loaded from Vault. Default: 10.
 *
 * Vault path: oweibo/tenants/{tenantId}/memory/promotion-threshold
 */
export class MemoryScopePromoter {
  constructor(
    private readonly qdrant: QdrantClient,
    private readonly store: LongTermMemoryStore,
    private readonly tracer?: MemoryTracer,
  ) {}

  async maybePromote(memoryId: string, entry: MemoryEntry, tenantId: string): Promise<void> {
    // Skip if already shared-scope or already promoted
    if (entry.scope.startsWith('tenant:') || entry.promotedToId) return;

    const promotedId = await this.store.store({
      tenantId,
      scope: `tenant:${tenantId}`,
      type: entry.type,
      tier: 'procedural',
      summary: `[Promoted] ${entry.summary}`,
      detail: { ...entry.detail as object, promotedFrom: memoryId, promotedAt: Date.now() },
      relevanceTags: [...entry.relevanceTags, 'promoted'],
    });

    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    await this.qdrant.setPayload(collection, {
      payload: { promotedToId: promotedId },
      points: [memoryId],
    });

    this.tracer?.tracePromotion(memoryId, `tenant:${tenantId}`, tenantId);
  }
}
```

---

## 9. MemoryConsolidator

```typescript
// packages/core-engine/src/agentic/MemoryConsolidator.ts
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { ModelRouter } from '../routing/ModelRouter';
import type { LongTermMemoryStore, MemoryEntry } from './LongTermMemoryStore';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';

/**
 * MemoryConsolidator — the agent's "sleep cycle".
 *
 * Runs daily alongside MemoryDecayService. Clusters recent episodic memories by
 * dominant relevanceTag, then asks the LLM to extract a generalizable insight —
 * converting raw task history into durable semantic or procedural knowledge.
 *
 * Algorithm:
 *   1. Scroll episodic memories created within CONSOLIDATION_WINDOW_DAYS.
 *   2. Filter to entries not yet marked consolidatedAt.
 *   3. Group by all relevanceTags (a memory with N tags appears in N clusters).
 *   4. For each group with >= MIN_CLUSTER_SIZE: extract insight via LLM (small model).
 *   5. Write insight as a 'domain-knowledge' memory at tenant scope.
 *   6. Mark source episodics as consolidated.
 *
 * LLM routing: always uses a small model (configured via Vault at
 * oweibo/infra/ltm/consolidation-model). Never hits the large planning model.
 * Input truncated to 8,000 chars to bound cost regardless of cluster size.
 */
export class MemoryConsolidator {
  private readonly MAX_INPUT_CHARS = 8_000;
  private readonly DEFAULT_MIN_CLUSTER_SIZE = 3;
  private readonly DEFAULT_CONSOLIDATION_WINDOW_DAYS = 7;

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly store: LongTermMemoryStore,
    private readonly modelRouter: ModelRouter,
    private readonly llmFactory: (modelId: string) => ILLMClient,
    private readonly logger: Logger,
    private readonly metrics: PrometheusClient,
    private readonly config: LongTermMemoryConfig = DEFAULT_LTM_CONFIG,
    private readonly secrets?: SecretsManager,
  ) {}

  /**
   * Load per-tenant consolidation tuning from Vault.
   * Vault path: oweibo/tenants/{tenantId}/memory/consolidation
   * Shape: { windowDays?: number; minClusterSize?: number; maxClustersPerCycle?: number }
   * Consistent with the per-tenant Vault override pattern used for promotionThreshold
   * and session TTL throughout this subsystem.
   */
  private async consolidationConfig(tenantId: string): Promise<{
    windowDays: number;
    minClusterSize: number;
    maxClustersPerCycle: number;
  }> {
    const defaults = {
      windowDays:          this.DEFAULT_CONSOLIDATION_WINDOW_DAYS,
      minClusterSize:      this.DEFAULT_MIN_CLUSTER_SIZE,
      maxClustersPerCycle: this.config.maxClustersPerCyclePerTenant,
    };
    if (!this.secrets) return defaults;
    try {
      const cfg = await this.secrets.getJSON(
        `oweibo/tenants/${tenantId}/memory/consolidation`
      );
      const c = cfg as {
        windowDays?: number;
        minClusterSize?: number;
        maxClustersPerCycle?: number;
      } | null;
      return {
        windowDays:          c?.windowDays          ?? defaults.windowDays,
        minClusterSize:      c?.minClusterSize      ?? defaults.minClusterSize,
        maxClustersPerCycle: c?.maxClustersPerCycle ?? defaults.maxClustersPerCycle,
      };
    } catch {
      return defaults;
    }
  }

  async runConsolidationCycle(tenantId: string): Promise<void> {
    const { windowDays, minClusterSize, maxClustersPerCycle } =
      await this.consolidationConfig(tenantId);
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const windowStart = Date.now() - windowDays * 86_400_000;
    const episodics = await this.scrollEpisodics(collection, windowStart);
    const clusters = this.clusterByTags(episodics);

    // Sort clusters largest-first so the highest-value consolidations run first
    // within the per-cycle LLM call budget. Without this sort, the cap is arbitrary.
    const qualifying = [...clusters.entries()]
      .filter(([, cluster]) => cluster.length >= minClusterSize)
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, maxClustersPerCycle);

    if (qualifying.length < clusters.size) {
      this.logger.warn('[MemoryConsolidator] cluster cap reached — deferring remaining clusters', {
        tenantId,
        total: clusters.size,
        processed: qualifying.length,
        cap: maxClustersPerCycle,
      });
      this.metrics.increment('oweibo_ltm_consolidation_cluster_cap_total', { tenant_id: tenantId });
    }

    for (const [tag, cluster] of qualifying) {
      await this.consolidateCluster(tenantId, tag, cluster);
    }
  }

  private async scrollEpisodics(collection: string, since: number): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    let offset: string | undefined;
    do {
      const page = await this.qdrant.scroll(collection, {
        limit: 100,
        offset,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { key: 'tier', match: { value: 'episodic' } },
            { key: 'createdAt', range: { gte: since } },
            // Exclude already-consolidated entries. consolidatedAt is a numeric Unix
            // timestamp when set and absent (null) when not yet processed. Using
            // is_null: true selects only entries where the field is absent — the
            // original must_not: { match: { value: true } } never matched because
            // consolidatedAt is never a boolean (gap: critical filter type mismatch).
            { is_null: { key: 'consolidatedAt', is_null: true } },
          ],
        },
      });
      results.push(...page.points.map(p => p.payload as MemoryEntry));
      offset = page.next_page_offset as string | undefined;
    } while (offset);
    return results;
  }

  private clusterByTags(entries: MemoryEntry[]): Map<string, MemoryEntry[]> {
    const clusters = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      // Index the entry under ALL its relevanceTags — not just tags[0].
      // A memory tagged ['typescript', 'auth'] appears in both clusters, enabling
      // cross-topic consolidation. The same entry may land in multiple clusters;
      // consolidatedAt is written once after the first successful cluster write so
      // subsequent cycles skip it regardless of which tag path triggered it.
      const tags = entry.relevanceTags.length > 0 ? entry.relevanceTags : ['general'];
      for (const tag of tags) {
        if (!clusters.has(tag)) clusters.set(tag, []);
        clusters.get(tag)!.push(entry);
      }
    }
    return clusters;
  }

  private async consolidateCluster(
    tenantId: string,
    tag: string,
    cluster: MemoryEntry[],
  ): Promise<void> {
    const modelId = await this.consolidationModel();
    const llm = this.llmFactory(modelId);

    // Truncate input to bound cost regardless of cluster size
    const rawSummaries = cluster.map(e => `- ${e.summary}`).join('\n');
    const summaries = rawSummaries.length > this.MAX_INPUT_CHARS
      ? rawSummaries.slice(0, this.MAX_INPUT_CHARS) + '\n[truncated]'
      : rawSummaries;

    const insight = await llm.generate({
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      userPrompt: `Tag: ${tag}\n\nEpisodic memories:\n${summaries}\n\nExtract a single generalizable insight as JSON: { "summary": string, "tier": "semantic" | "procedural", "tags": string[] }`,
      responseFormat: 'json',
    });

    // Attempt to parse LLM output; retry once with a fresh generation before giving up.
    // Previously this was a silent return — failures were invisible and accumulated
    // indefinitely, leaving clusters permanently unconsolidated (gap: no retry/metric).
    let parsed: { summary: string; tier: 'semantic' | 'procedural'; tags: string[] } | null = null;
    let llmOutput = insight;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        parsed = JSON.parse(llmOutput.output);
        break;
      } catch {
        if (attempt === 1) {
          llmOutput = await llm.generate({
            systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
            userPrompt: `Tag: ${tag}\n\nEpisodic memories:\n${summaries}\n\nExtract a single generalizable insight as JSON: { "summary": string, "tier": "semantic" | "procedural", "tags": string[] }`,
            responseFormat: 'json',
          });
        }
      }
    }
    if (!parsed) {
      this.logger.warn('[MemoryConsolidator] malformed LLM output after retry — skipping cluster', {
        tag,
        clusterSize: cluster.length,
        tenantId,
      });
      this.metrics.increment('oweibo_ltm_consolidation_parse_failure_total', {
        tag,
        tenant_id: tenantId,
      });
      return;
    }

    await this.store.store({
      tenantId,
      scope: `tenant:${tenantId}`,
      type: 'domain-knowledge',
      tier: parsed.tier,
      summary: parsed.summary,
      detail: { consolidatedFrom: cluster.map(e => e.id), tag, clusterSize: cluster.length },
      relevanceTags: parsed.tags,
    });

    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    await this.qdrant.setPayload(collection, {
      payload: { consolidatedAt: Date.now() },
      points: cluster.map(e => e.id),
    });
  }

  private async consolidationModel(): Promise<string> {
    if (!this.secrets) return 'ollama/llama3';
    try {
      const cfg = await this.secrets.getJSON('oweibo/infra/ltm/consolidation-model');
      return (cfg as { model?: string })?.model ?? 'ollama/llama3';
    } catch {
      return 'ollama/llama3';
    }
  }
}

const CONSOLIDATION_SYSTEM_PROMPT = `
You are a memory consolidation engine for a multi-agent software factory.
You receive a cluster of raw episodic memories grouped by topic.
Extract a single generalizable insight that would help a future agent handle similar tasks better.
The insight must be concrete, actionable, and free of task-specific IDs, file names, or ephemeral details.
Classify it as 'semantic' (factual knowledge) or 'procedural' (how-to knowledge).
Respond ONLY with the JSON object — no preamble or markdown.
`;
```

---

## 10. STMCompressor

```typescript
// packages/core-engine/src/agentic/STMCompressor.ts
import type { ModelRouter } from '../routing/ModelRouter';
import type { ILLMClient, Plan, DecisionLog } from '@oweibo/core-contracts';
import type { STMEntry } from './ShortTermMemoryStore';

/**
 * STMCompressor — distills a task's working context before LTM consolidation.
 *
 * Runs at task end, after the last sub-goal and before any LTM write.
 * Replaces direct consolidateFromTask() calls that wrote raw, noisy DecisionLog[].
 *
 * Uses a small model — not the large planning model.
 * Vault: oweibo/infra/ltm/consolidation-model (shared with MemoryConsolidator).
 *
 * Output CompressedTaskMemory is what gets written to LTM — clean, generalisable,
 * stripped of task-specific IDs and ephemeral file paths.
 */
export interface CompressedTaskMemory {
  /** One-sentence summary of what was accomplished. */
  outcomeStatement: string;
  /** Decisions that generalise beyond this specific task. */
  generalizableDecisions: Array<{ insight: string; tags: string[] }>;
  /** Failure patterns worth persisting. */
  failurePatterns: Array<{ stage: string; pattern: string; avoidance: string }>;
  /** 0–1 estimate of overall task success quality. */
  successQuality: number;
}

export class STMCompressor {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly llmFactory: (modelId: string) => ILLMClient,
  ) {}

  async compress(params: {
    taskDescription: string;
    plan: Plan;
    decisions: DecisionLog[];
  }): Promise<CompressedTaskMemory> {
    const modelId = await this.modelRouter.selectModel('summarization');
    const llm = this.llmFactory(modelId);

    const raw = JSON.stringify({
      plan: params.plan.strategy,
      decisions: params.decisions.map(d => ({
        stage: d.stage,
        outcome: d.outcome,
        decision: d.decision.slice(0, 200),
      })),
    });

    const result = await llm.generate({
      systemPrompt: STM_COMPRESSOR_SYSTEM_PROMPT,
      userPrompt: `Task: ${params.taskDescription}\n\nExecution trace:\n${raw}`,
      responseFormat: 'json',
    });

    return JSON.parse(result.output) as CompressedTaskMemory;
  }

  /**
   * Crash-recovery variant — compresses raw STMEntry[] when no Plan or DecisionLog
   * is available (e.g. CognitiveEngine crashed before writing to LTM).
   * Called exclusively by UnifiedMemorySystem.endSession() safety-net path.
   */
  async compressEntries(
    entries: STMEntry[],
  ): Promise<CompressedTaskMemory> {
    const modelId = await this.modelRouter.selectModel('summarization');
    const llm = this.llmFactory(modelId);

    const raw = JSON.stringify(
      entries
        .sort((a, b) => a.turnIndex - b.turnIndex)
        .map(e => ({ role: e.role, summary: e.summary, tags: e.tags }))
    );

    const result = await llm.generate({
      systemPrompt: STM_COMPRESSOR_SYSTEM_PROMPT,
      userPrompt: `Session entries (crash-recovery — no task plan available):\n${raw}`,
      responseFormat: 'json',
    });

    return JSON.parse(result.output) as CompressedTaskMemory;
  }
}

const STM_COMPRESSOR_SYSTEM_PROMPT = `
You are a memory distillation engine for an AI software agent.
You receive a task execution trace and extract only what is worth remembering long-term.
Remove all task-specific IDs, file names, and ephemeral details.
Extract only generalizable insights, failure patterns, and a brief outcome statement.
Estimate successQuality from 0 to 1 based on the ratio of successful to failed decisions.
Output ONLY JSON matching CompressedTaskMemory. No markdown, no preamble.
`;
```

---

## 11. MemoryWarmer

```typescript
// packages/core-engine/src/agentic/MemoryWarmer.ts
import type { LongTermMemoryStore } from './LongTermMemoryStore';
import type { ShortTermMemoryStore } from './ShortTermMemoryStore';
import type { ModelRouter } from '../routing/ModelRouter';

/**
 * MemoryWarmer — proactive memory injection at task start.
 *
 * Called before the first agent prompt is assembled. Queries four distinct
 * recall channels and merges them into a single structured XML block:
 *
 *   1. Agent-scope LTM   — role+taskId episodic memories (highest boost)
 *   2. Project-scope LTM — project-specific architecture/conventions (second)
 *   3. STM               — current session turns, normalised to LTM scale (third)
 *   4. Tenant-scope LTM  — promoted tenant-wide procedures (lowest boost)
 *
 * userProfile is NOT handled here. It is loaded by UserProfileStore and injected
 * as a separate fixed PromptComponents.userProfile block — it never competes with
 * warmMemory for prompt budget because it occupies its own dedicated slot.
 *
 * Injected position in the prompt assembly chain:
 *   repoMap → projectRules → skills → userProfile → projectMemory → warmMemory → conversationHistory → systemPrompt
 *
 * Soft-boost merge: each channel queries the full topK; results are boosted
 * by channel priority before sorting. STM scores are normalised to the LTM
 * composite scale before boosting so all results are commensurable.
 * Empty channels waste no slots.
 *
 * Token-aware: respects maxTokens cap. PromptBudgetEnforcer enforces the
 * final assembled limit across all components.
 *
 * Returns '' if no memories qualify — never injects an empty block.
 */
export class MemoryWarmer {
  constructor(
    private readonly ltm: LongTermMemoryStore,
    private readonly stm: ShortTermMemoryStore | null,
    private readonly modelRouter: ModelRouter,
  ) {}

  async warmForTask(params: {
    tenantId: string;
    agentScope: string;
    taskDescription: string;
    projectId?: string;   // if provided, project-scope LTM is queried as a second channel
    sessionId?: string;
    topK?: number;
    maxTokens?: number;
  }): Promise<string> {
    const {
      tenantId,
      agentScope,
      taskDescription,
      projectId,
      sessionId,
      topK = 6,
      maxTokens = 3_000,
    } = params;

    // Boost values encode channel priority — higher = more likely to appear in topK.
    //   AGENT_BOOST:   role+taskId episodic — most specific to this agent and task
    //   PROJECT_BOOST: project-scoped knowledge — conditionally relevant, high signal
    //   STM_BOOST:     current session context — maximally recent
    //   SHARED_BOOST:  tenant-wide procedures — broad, lower specificity
    const AGENT_BOOST   = 0.10;
    const PROJECT_BOOST = 0.08;
    const STM_BOOST     = 0.06;
    const SHARED_BOOST  = 0.03;

    // STM normalisation: raw cosine (0–1) → LTM composite scale
    const STM_SIM_WEIGHT    = 0.60;
    const STM_RECENCY_BOOST = 0.25;

    type ScoredResult = { entry: unknown; score: number };

    const ltmAgentP = this.ltm.recall(tenantId, taskDescription, {
      scope: agentScope,
      topK,
      minScore: 0.35,
    }).then((rs): ScoredResult[] =>
      rs.map(r => ({ entry: r.entry, score: r.score + AGENT_BOOST }))
    );

    const queries: Promise<ScoredResult[]>[] = [ltmAgentP];

    // Project-scope channel — only fired when projectId is provided
    if (projectId) {
      queries.push(
        this.ltm.recall(tenantId, taskDescription, {
          scope:    TenantKeyBuilder.projectScope(projectId),
          tiers:    ['semantic', 'procedural'],
          topK,
          minScore: 0.40,
        }).then((rs): ScoredResult[] =>
          rs.map(r => ({ entry: r.entry, score: r.score + PROJECT_BOOST }))
        )
      );
    }

    // STM channel — normalise to LTM scale before boosting
    if (sessionId && this.stm) {
      queries.push(
        this.stm.recall(tenantId, sessionId, taskDescription, topK, 0.35)
          .then((rs): ScoredResult[] =>
            rs.map(r => ({
              entry: r.entry,
              score: (STM_SIM_WEIGHT * r.score + STM_RECENCY_BOOST) + STM_BOOST,
            }))
          )
      );
    }

    // Shared tenant-scope channel — lowest boost; catches promoted procedures
    // with no project or covers tenants without projectId context
    queries.push(
      this.ltm.recall(tenantId, taskDescription, {
        scope:    `tenant:${tenantId}`,
        tiers:    ['semantic', 'procedural'],
        topK,
        minScore: 0.45,
      }).then((rs): ScoredResult[] =>
        rs.map(r => ({ entry: r.entry, score: r.score + SHARED_BOOST }))
      )
    );

    const tierResults = await Promise.all(queries);
    const combined = tierResults
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (combined.length === 0) return '';

    // Build block within token budget
    const lines: string[] = [];
    let tokenCount = 0;

    for (const r of combined) {
      const entry = r.entry as Record<string, unknown>;
      const tier  = (entry['tier']    as string | undefined) ?? 'stm';
      const type  = (entry['type']    as string | undefined) ?? 'session';
      const summary = (entry['summary'] as string | undefined) ?? '';
      const line = `  <memory tier="${tier}" type="${type}" score="${r.score.toFixed(2)}">${summary}</memory>`;
      const lineTokens = this.modelRouter.countTokens(line);
      if (tokenCount + lineTokens > maxTokens) break;
      lines.push(line);
      tokenCount += lineTokens;
    }

    return lines.length > 0
      ? `<warm_memory>\n${lines.join('\n')}\n</warm_memory>`
      : '';
  }
}
```

---

## 12. PromptBudgetEnforcer

```typescript
// packages/core-engine/src/agentic/PromptBudgetEnforcer.ts
import type { ModelRouter } from '../routing/ModelRouter';
import type { SecretsManager } from '../secrets/SecretsManager';

/**
 * PromptBudgetEnforcer — mandatory final step in prompt assembly.
 *
 * Every prompt assembly site (GeneralCodingOrchestrator, BaseAgent, ConversationalLoop)
 * must route through enforce() instead of manually joining sections. This is the single
 * point where the entire assembled prompt is token-counted and truncated if necessary.
 *
 * Design invariants:
 *   1. systemPrompt is NEVER truncated — it is the agent's core identity.
 *   2. userProfile is NEVER truncated — it is always-relevant user context.
 *      UserProfileStore pre-truncates to userProfileTokenCap before passing it in,
 *      so the budget is already respected before enforce() is called.
 *   3. Truncation order (lowest to highest priority):
 *      repoMap → conversationHistory → warmMemory → skills → projectRules
 *      userProfile and systemPrompt are exempt from this order.
 *   4. Token counts use ModelRouter's real tokenizer — never char/4 estimates.
 *   5. Budget loaded from Vault per-tenant; falls back to FALLBACK_BUDGET.
 *   6. Emits a Langfuse span with totalTokens and truncation map.
 *
 * Prompt assembly chain (canonical order):
 *   repoMap → projectRules → skills → userProfile → warmMemory → conversationHistory → systemPrompt
 *
 * Vault path: oweibo/tenants/{tenantId}/memory/prompt-budget
 */

export interface PromptBudget {
  maxTotalTokens: number;
  reservedForCompletion: number;
  componentCaps: {
    repoMap: number;
    projectRules: number;
    skills: number;
    userProfile: number;     // pre-truncated by UserProfileStore; cap here is a safety net
    warmMemory: number;
    conversationHistory: number;
    systemPrompt: number;
  };
}

const FALLBACK_BUDGET: PromptBudget = {
  maxTotalTokens: 120_000,
  reservedForCompletion: 8_000,
  componentCaps: {
    repoMap:             12_000,
    projectRules:         4_000,
    skills:               8_000,
    userProfile:            700,  // slightly above userProfileTokenCap default of 600
    warmMemory:           3_000,
    conversationHistory: 60_000,
    systemPrompt:      Infinity,
  },
};

export interface PromptComponents {
  repoMap?: string;
  projectRules?: string;
  skills?: string;
  userProfile?: string;    // rendered by UserProfileStore — fixed, non-recalled, never truncated
  warmMemory?: string;
  conversationHistory?: string;
  systemPrompt: string;    // required — never truncated
}

export interface BudgetedPrompt {
  assembled: string;
  totalTokens: number;
  truncations: Record<string, boolean>;
}

export class PromptBudgetEnforcer {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly secrets: SecretsManager,
  ) {}

  async loadBudget(tenantId: string): Promise<PromptBudget> {
    try {
      const raw = await this.secrets.getJSON(
        `oweibo/tenants/${tenantId}/memory/prompt-budget`
      );
      return { ...FALLBACK_BUDGET, ...(raw ?? {}) };
    } catch {
      return FALLBACK_BUDGET;
    }
  }

  async enforce(tenantId: string, components: PromptComponents): Promise<BudgetedPrompt> {
    const budget = await this.loadBudget(tenantId);
    const usable = budget.maxTotalTokens - budget.reservedForCompletion;
    const truncations: Record<string, boolean> = {};
    const tokenize = (text: string | undefined) =>
      text ? this.modelRouter.countTokens(text) : 0;

    // Reserve budget for the two never-truncated sections first
    const systemTokens  = tokenize(components.systemPrompt);
    const profileTokens = Math.min(
      tokenize(components.userProfile),
      budget.componentCaps.userProfile,
    );
    let remaining = usable - systemTokens - profileTokens;

    // Truncation priority order — leftmost evicted first under budget pressure.
    // userProfile and systemPrompt are handled separately above and are exempt.
    const order: Array<keyof Omit<PromptComponents, 'systemPrompt' | 'userProfile'>> = [
      'repoMap',
      'conversationHistory',
      'warmMemory',
      'skills',
      'projectRules',
    ];

    const fitted: Partial<PromptComponents> = {
      systemPrompt: components.systemPrompt,
      userProfile:  components.userProfile,   // always included, already within cap
    };

    for (const key of order) {
      const text = components[key];
      if (!text) continue;
      const cap = budget.componentCaps[key as keyof typeof budget.componentCaps] as number;
      const rawTokens = tokenize(text);
      const cappedText = rawTokens > cap ? this.truncateToTokens(text, cap) : text;
      const tokens = Math.min(rawTokens, cap);

      if (tokens <= remaining) {
        fitted[key] = cappedText;
        remaining -= tokens;
        truncations[key] = rawTokens > cap;
      } else if (remaining > 200) {
        fitted[key] = this.truncateToTokens(cappedText, remaining);
        truncations[key] = true;
        remaining = 0;
      } else {
        truncations[key] = true;
      }
    }

    // Canonical assembly order:
    //   repoMap → projectRules → skills → userProfile → warmMemory → conversationHistory → systemPrompt
    //
    // userProfile sits between skills and warmMemory: it is always-relevant fixed context
    // that precedes the dynamically-recalled warmMemory so the agent reads who it is
    // working with before reading what it knows about the current task.
    const sections = [
      fitted.repoMap,
      fitted.projectRules,
      fitted.skills,
      fitted.userProfile,
      fitted.warmMemory,
      fitted.conversationHistory,
      fitted.systemPrompt,
    ].filter(Boolean) as string[];

    const assembled = sections.join('\n\n---\n\n');
    return { assembled, totalTokens: tokenize(assembled), truncations };
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.modelRouter.countTokens(text.slice(0, mid)) <= maxTokens) lo = mid + 1;
      else hi = mid;
    }
    return text.slice(0, lo - 1) + '\n[truncated by PromptBudgetEnforcer]';
  }
}
```

**Wire-up — all prompt assembly sites:**

```typescript
// Replace every manual join in GeneralCodingOrchestrator, BaseAgent, ConversationalLoop.
// userProfile is loaded from UserProfileStore before enforce() is called.

const userProfile = userId
  ? this.userProfileStore.renderProfile(
      await this.userProfileStore.loadProfile(task.tenantId, userId)
    )
  : '';

const { assembled: systemPrompt, totalTokens, truncations } =
  await this.budgetEnforcer.enforce(task.tenantId, {
    repoMap,
    projectRules,
    skills:              skillsPrefix,
    userProfile,         // fixed — never recalled semantically, always injected
    warmMemory,          // semantically recalled: agent + project + STM + tenant channels
    conversationHistory,
    systemPrompt:        BASE_SYSTEM_PROMPT,
  });

if (Object.values(truncations).some(Boolean)) {
  this.logger.warn('[PromptBudgetEnforcer] truncations applied', { truncations, totalTokens });
}
```

---

## 13. IMemorySystem Facade

```typescript
// packages/core-contracts/src/interfaces/IMemorySystem.ts
import type { MemoryType, MemoryTier } from '../../../core-engine/src/agentic/LongTermMemoryStore';
import type { STMEntry } from '../../../core-engine/src/agentic/ShortTermMemoryStore';

/**
 * IMemorySystem — unified agent memory interface.
 *
 * Agents program to this facade only. The UnifiedMemorySystem implementation
 * decides which tier serves each operation:
 *   - recall(): normalised-score merge of STM and LTM results, cross-tier
 *     deduplicated. STM cosine scores are projected onto the LTM composite
 *     scale before sorting — results rank by relevance, not by tier.
 *   - store(): immediate STM write (with userId propagated); LTM written at
 *     task end via STMCompressor
 *   - warmForTask(): four-channel soft-boost merge (agent + project + STM + tenant)
 *     into a single XML block. userProfile is NOT included here — it is loaded
 *     separately by UserProfileStore and injected as PromptComponents.userProfile.
 *   - endSession(): tears down STM; crash-recovery LTM write if normal task-end
 *     consolidation did not run (e.g. worker crash before task completion)
 */
export interface UnifiedRecallResult {
  entry: STMEntry | import('../../../core-engine/src/agentic/LongTermMemoryStore').MemoryEntry;
  score: number;
  tier: 'stm' | 'ltm';
}

export interface IMemorySystem {
  recall(params: {
    tenantId: string;
    sessionId: string;
    agentScope: string;
    query: string;
    topK?: number;
    minScore?: number;
  }): Promise<UnifiedRecallResult[]>;

  store(params: {
    tenantId: string;
    userId?: string;    // propagated into STMEntry and LTM MemoryEntry
    sessionId: string;
    scope: string;
    type: MemoryType;
    tier: MemoryTier;
    summary: string;
    detail: unknown;
    relevanceTags: string[];
  }): Promise<string>;

  reinforce(memoryId: string, tenantId: string): Promise<void>;
  penalise(memoryId: string, tenantId: string): Promise<void>;

  warmForTask(params: {
    tenantId: string;
    sessionId: string;
    agentScope: string;
    taskDescription: string;
    projectId?: string;   // enables project-scope recall channel in MemoryWarmer
    maxTokens?: number;
  }): Promise<string>;

  endSession(tenantId: string, sessionId: string): Promise<void>;
}

// ─── Implementation ────────────────────────────────────────────────────────────

// packages/core-engine/src/agentic/UnifiedMemorySystem.ts
import type { ShortTermMemoryStore } from './ShortTermMemoryStore';
import type { LongTermMemoryStore, MemoryEntry } from './LongTermMemoryStore';
import type { MemoryWarmer } from './MemoryWarmer';
import type { STMCompressor } from './STMCompressor';
import type { IMemorySystem, UnifiedRecallResult } from '@oweibo/core-contracts';
import type { Logger } from '../infra/Logger';
export class UnifiedMemorySystem implements IMemorySystem {
  // STM recall() returns raw cosine (0–1). LTM recall() returns a composite score
  // (α·cosine + β·recency + γ·successRate). To merge and sort them correctly the
  // STM score is projected onto the LTM composite scale before the merge
  // (gap: previously merged raw cosine with composite — sort order was meaningless).
  private readonly STM_SIM_WEIGHT    = 0.60;  // mirrors LongTermMemoryConfig.similarityWeight
  private readonly STM_RECENCY_BOOST = 0.25;  // mirrors LongTermMemoryConfig.recencyWeight

  constructor(
    private readonly stm: ShortTermMemoryStore,
    private readonly ltm: LongTermMemoryStore,
    private readonly warmer: MemoryWarmer,
    private readonly stmCompressor: STMCompressor,
    private readonly logger: Logger,
  ) {}

  async recall(params: Parameters<IMemorySystem['recall']>[0]): Promise<UnifiedRecallResult[]> {
    const { tenantId, sessionId, agentScope, query, topK = 8, minScore = 0.3 } = params;

    // Both tiers query the full topK — slack from an empty tier (e.g. no STM on
    // first turn) is absorbed by the other, ensuring topK results whenever possible
    // (gap: half/half split meant an empty tier silently shrank the result set).
    const [stmResults, ltmResults] = await Promise.all([
      this.stm.recall(tenantId, sessionId, query, topK, minScore),
      this.ltm.recallForAgent(tenantId, agentScope, query, topK, minScore),
    ]);

    // Normalise STM cosine scores to the LTM composite scale.
    const normalised: UnifiedRecallResult[] = [
      ...stmResults.map(r => ({
        entry: r.entry,
        score: this.STM_SIM_WEIGHT * r.score + this.STM_RECENCY_BOOST,
        tier: 'stm' as const,
      })),
      ...ltmResults.map(r => ({ entry: r.entry, score: r.score, tier: 'ltm' as const })),
    ];

    // Cross-tier deduplication: two entries with identical summaries (same memory
    // consolidated from STM into LTM) would otherwise appear twice. Deduplicate
    // by summary fingerprint (trimmed, lowercased) keeping the higher-scored copy
    // (gap: STM + LTM could return the same consolidated memory twice).
    const seen = new Map<string, UnifiedRecallResult>();
    for (const r of normalised.sort((a, b) => b.score - a.score)) {
      const key = ((r.entry as Record<string, unknown>)['summary'] as string ?? '')
        .trim().toLowerCase().slice(0, 120);
      if (!seen.has(key)) seen.set(key, r);
    }

    return [...seen.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async store(params: Parameters<IMemorySystem['store']>[0]): Promise<string> {
    // Immediate STM write. LTM write is deferred to task end via STMCompressor in
    // CognitiveEngine.processTask(). This is intentional: LTM entries are distilled
    // from a complete task trace, not individual turns. Crash durability is handled
    // by the endSession() safety-net path below.
    return this.stm.store({
      tenantId:  params.tenantId,
      userId:    params.userId,       // propagated for per-user session recall
      sessionId: params.sessionId,
      turnIndex: Date.now(),
      role:      'agent',
      summary:   params.summary,
      detail:    params.detail,
      tags:      params.relevanceTags,
    });
  }

  /**
   * reinforce() — routes to LTM only (STM entries have no successCount field).
   * The memoryId must be an LTM UUID. STM quality signals are tracked implicitly
   * through the STMCompressor successQuality field at task end.
   */
  async reinforce(memoryId: string, tenantId: string): Promise<void> {
    await this.ltm.reinforce(memoryId, tenantId);
  }

  /**
   * penalise() — routes to LTM only for the same reason as reinforce().
   * Callers should invoke this after detecting that a recalled memory was
   * not useful — e.g. the agent explicitly discarded the recalled context.
   */
  async penalise(memoryId: string, tenantId: string): Promise<void> {
    await this.ltm.penalise(memoryId, tenantId);
  }

  async warmForTask(params: Parameters<IMemorySystem['warmForTask']>[0]): Promise<string> {
    return this.warmer.warmForTask({
      tenantId:        params.tenantId,
      agentScope:      params.agentScope,
      taskDescription: params.taskDescription,
      projectId:       params.projectId,   // enables project-scope recall channel
      sessionId:       params.sessionId,
      maxTokens:       params.maxTokens ?? 3_000,
    });
  }

  /**
   * endSession() — tears down the STM warm layer for this session and runs a
   * best-effort crash-recovery LTM write for any session whose CognitiveEngine
   * did not reach its normal task-end consolidation path (e.g. worker crash, OOM).
   *
   * Recovery logic:
   *   1. Drain all warm-layer STM entries via scrollSession() before destroying them.
   *   2. If entries exist and no LTM entry for this session scope was written
   *      (checked by a scoped LTM recall with a deliberately low threshold),
   *      compress the STM entries via STMCompressor.compressEntries() and
   *      write the result to LTM under the session scope.
   *   3. Call destroySession(): evicts the hot in-process layer, deletes the session
   *      counter key, and SCAN-deletes all warm entry hashes for this session.
   *      Individual hashes also expire via their own native Redis TTL, so this step
   *      is an explicit early cleanup rather than a critical dependency.
   *
   * This is best-effort: a failure in the recovery write is logged but does not
   * propagate — session teardown must always succeed (gap: task crash before task
   * end previously lost all mid-task LTM writes with no recovery path).
   */
  async endSession(tenantId: string, sessionId: string): Promise<void> {
    const sessionScope = `session:${sessionId}`;

    try {
      // 1. Drain STM before the collection is destroyed
      const stmEntries = await this.stm.scrollSession(tenantId, sessionId);

      if (stmEntries.length > 0) {
        // 2. Check whether normal task-end LTM consolidation already ran
        const existingLtm = await this.ltm.recall(tenantId, stmEntries[0].summary, {
          scope: sessionScope,
          topK: 1,
          minScore: 0.5,
        });

        if (existingLtm.length === 0) {
          // No LTM write found — crash-recovery path
          const compressed = await this.stmCompressor.compressEntries(stmEntries);
          await this.ltm.store({
            tenantId,
            scope: sessionScope,
            type: 'successful-strategy',
            tier: 'episodic',
            summary: `[crash-recovery] ${compressed.outcomeStatement}`,
            detail: compressed,
            relevanceTags: stmEntries.flatMap(e => e.tags).filter((v, i, a) => a.indexOf(v) === i),
          });
          this.logger.warn('[UnifiedMemorySystem] crash-recovery LTM write on endSession', {
            tenantId,
            sessionId,
            stmEntryCount: stmEntries.length,
          });
        }
      }
    } catch (err) {
      // Non-fatal — log and proceed to collection teardown
      this.logger.error('[UnifiedMemorySystem] endSession recovery failed', { tenantId, sessionId, err });
    }

    await this.stm.destroySession(tenantId, sessionId);
  }
}
```

**Wire-up — `UnifiedMemorySystem` construction (all call sites):**

```typescript
// UnifiedMemorySystem requires stmCompressor and logger in addition to the
// original stm / ltm / warmer params. UserProfileStore is constructed separately
// and injected into the prompt assembly sites (not into UnifiedMemorySystem directly —
// it is a prompt concern, not a recall concern).
//
// Example (main.ts or AgentFactory):
const unifiedMemory = new UnifiedMemorySystem(
  stm,           // ShortTermMemoryStore
  ltm,           // LongTermMemoryStore  (must have tracer wired via setPromoter pattern)
  warmer,        // MemoryWarmer
  stmCompressor, // STMCompressor        ← crash-recovery compressEntries()
  logger,        // Logger               ← crash-recovery warn/error logging
);

// UserProfileStore is constructed at the same DI root and injected into
// ConversationalLoop, GeneralCodingOrchestrator, and BaseAgent separately.
// It no longer depends on LongTermMemoryStore — preferences are owned by Postgres.
const userProfileStore = new UserProfileStore(
  pg,
  redis,
  modelRouter,
  config.userProfileTokenCap,
);
```

---

```typescript
// packages/core-engine/src/agentic/MemoryTracer.ts
import type { LangfuseTraceClient } from 'langfuse';

/**
 * MemoryTracer — thin Langfuse wrapper for all memory operations.
 *
 * Used via composition in:
 *   - LongTermMemoryStore  — injected via constructor; wraps recall() in traceRecall()
 *   - MemoryScopePromoter  — tracePromotion() + traceCompositeScore() events
 *   - MemoryDecayService   — traceDecayCycle() span
 *
 * ShortTermMemoryStore does not hold a tracer directly; STM recall spans are
 * captured at the UnifiedMemorySystem level when both tiers are called together.
 *
 * Provides spans for: LTM recall, decay cycle, promotion, composite scoring.
 */
export class MemoryTracer {
  constructor(private readonly trace: LangfuseTraceClient) {}

  async traceRecall<T>(
    name: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const span = this.trace.span({ name: `memory-recall:${name}`, input: meta });
    try {
      const result = await fn();
      span.end({ output: { resultCount: Array.isArray(result) ? result.length : 1 } });
      return result;
    } catch (err) {
      span.end({ output: { error: String(err) } });
      throw err;
    }
  }

  async traceDecayCycle(tenantId: string, fn: () => Promise<void>): Promise<void> {
    const span = this.trace.span({ name: 'memory-decay-cycle', input: { tenantId } });
    try {
      await fn();
      span.end({ output: { status: 'ok' } });
    } catch (err) {
      span.end({ output: { error: String(err) } });
      throw err;
    }
  }

  tracePromotion(memoryId: string, scope: string, tenantId: string): void {
    this.trace.event({ name: 'memory-promoted', input: { memoryId, scope, tenantId } });
  }

  traceCompositeScore(memoryId: string, cosine: number, composite: number, tier: string): void {
    this.trace.event({ name: 'memory-composite-score', input: { memoryId, cosine, composite, tier } });
  }
}
```

---

## 15. LtmBackupService

```typescript
// packages/core-engine/src/jobs/LtmBackupService.ts
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { S3Client } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';

/**
 * LtmBackupService — daily Qdrant snapshots per tenant, streamed to S3.
 *
 * Strategy:
 *   1. qdrant.createSnapshot() per tenant collection.
 *   2. Download + stream to S3 under ltm-backups/{tenantId}/{date}/{snapshot_name}.
 *   3. Delete snapshot from Qdrant after successful S3 upload (Qdrant disk ≠ backup target).
 *   4. S3 lifecycle policy retains 30 daily snapshots per tenant.
 *
 * Failure: non-fatal per-tenant. Logs error, increments Prometheus metric
 * oweibo_ltm_backup_failure_total{tenant_id}. Alerts if > 0 in 24h window.
 *
 * Concurrency: p-limited to maxConcurrentTenants (default 10) — matches the
 * pattern used by MemoryDecayService to avoid bursting the Qdrant snapshot API
 * (gap: original used Promise.all with no concurrency cap).
 *
 * Vault path for S3 bucket: oweibo/infra/ltm-backup/s3-bucket
 */
export class LtmBackupService {
  constructor(
    private readonly qdrant: QdrantClient,
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly tenantIds: () => Promise<string[]>,
    private readonly metrics: PrometheusClient,
    private readonly logger: Logger,
    private readonly maxConcurrentTenants: number = 10,
  ) {}

  async runBackupCycle(): Promise<void> {
    const tenants = await this.tenantIds();
    const limit = pLimit(this.maxConcurrentTenants);
    await Promise.all(tenants.map(tid => limit(() => this.backupTenant(tid))));
  }

  private async backupTenant(tenantId: string): Promise<void> {
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    try {
      const { snapshot_name } = await this.qdrant.createSnapshot(collection);
      const data = await this.qdrant.downloadSnapshot(collection, snapshot_name);
      const key = `ltm-backups/${tenantId}/${new Date().toISOString().slice(0, 10)}/${snapshot_name}`;
      await this.s3.putObject({ Bucket: this.bucket, Key: key, Body: data });
      await this.qdrant.deleteSnapshot(collection, snapshot_name);
    } catch (err) {
      this.logger.error(`[LtmBackup] Failed for ${tenantId}`, { err });
      this.metrics.increment('oweibo_ltm_backup_failure_total', { tenant_id: tenantId });
    }
  }
}
```

---

## 16. LtmMigrationService

```typescript
// packages/core-engine/src/jobs/LtmMigrationService.ts
import type { QdrantClient } from '@qdrant/js-client-rest';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder';
import type { MemoryEntry } from '../agentic/LongTermMemoryStore';

/**
 * LtmMigrationService — versioned, idempotent schema migration for LTM collections.
 *
 * Schema version is stored in each collection's metadata alias.
 * Each migration step is guarded: if currentVersion >= targetVersion, skip.
 * Safe to run on every deploy.
 *
 * Current version: 2 (v9.5)
 *   Migration 1→2: rename 'agent-long-term-memory' → 'agent-ltm:{tenantId}',
 *   backfill tenantId, tier, missCount, confidence, lastReinforcedAt, scope.
 *
 * Postgres: ltm_archive table created alongside the migration (DDL below).
 */
export class LtmMigrationService {
  private readonly CURRENT_SCHEMA_VERSION = 2;

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly pg: Pool,
    private readonly tenantIds: () => Promise<string[]>,
    // P-4 fix: embedFn is required so migration can re-embed 384-dim source vectors
    // into the target collection's actual dimension rather than copying mismatched vectors.
    // The function must be the same instance used by the rest of the memory system so
    // all collections are on the same embedding space after migration completes.
    private readonly embedFn: (text: string) => Promise<number[]>,
  ) {}

  async migrate(): Promise<void> {
    await this.ensureArchiveTable();
    const tenants = await this.tenantIds();
    await Promise.all(tenants.map(tid => this.migrateTenant(tid)));
  }

  private async ensureArchiveTable(): Promise<void> {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS ltm_archive (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        scope        TEXT NOT NULL,
        type         TEXT NOT NULL,
        tier         TEXT NOT NULL,
        summary      TEXT NOT NULL,
        detail       JSONB,
        archived_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ltm_archive_tenant ON ltm_archive (tenant_id);

      CREATE TABLE IF NOT EXISTS user_profiles (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        content     JSONB NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_profiles_lookup
        ON user_profiles (tenant_id, user_id);

      -- Canonical preference store — upsertPreference() targets this table exclusively.
      -- Separated from user_profiles JSONB so individual keys can be upserted via
      -- UNIQUE (tenant_id, user_id, key) without full-document rewrites, and to keep
      -- structured profile fields and free-form preferences in distinct columns.
      CREATE TABLE IF NOT EXISTS user_preferences (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        confidence  REAL NOT NULL DEFAULT 1.0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, user_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_preferences_lookup
        ON user_preferences (tenant_id, user_id);
    `);
  }

  private async migrateTenant(tenantId: string): Promise<void> {
    const legacyName = 'agent-long-term-memory';
    const newName = TenantKeyBuilder.ltmCollection(tenantId);
    const existing = await this.qdrant.getCollections();
    const names = new Set(existing.collections.map(c => c.name));

    if (names.has(legacyName) && !names.has(newName)) {
      await this.runMigration1to2(tenantId, legacyName, newName);
    }
    // Future: if (schemaVersion < 3) await this.runMigration2to3(...)
  }

  private async runMigration1to2(tenantId: string, from: string, to: string): Promise<void> {
    // P-4 fix: probe the target vector dimension from embedFn before creating the
    // collection. The source collection was written by all-MiniLM-L6-v2 (384-dim);
    // hardcoding 1536 caused every upsert to fail with a VectorDimensionError because
    // Qdrant rejects vectors whose length does not match the collection schema.
    // Dimension varies by hardware profile: 384 (MiniLM), 768 (nomic-embed-text via
    // Ollama), 1024 (mxbai-embed-large), 1536 (text-embedding-ada-002). The probe
    // must run before createCollection; if embedFn throws, migration aborts cleanly.
    const probeVector = await this.embedFn('migration dimension probe');
    const vectorSize = probeVector.length;

    await this.qdrant.createCollection(to, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
    for (const field of ['tenantId', 'scope', 'type', 'tier', 'consolidatedAt', 'userId', 'projectId']) {
      await this.qdrant.createPayloadIndex(to, {
        field_name: field,
        // consolidatedAt uses float schema (Unix epoch timestamp); is_null filter
        // in MemoryConsolidator works with absent payload fields regardless of schema.
        // userId and projectId are optional keyword fields; absent when not set.
        field_schema: field === 'consolidatedAt' ? 'float' : 'keyword',
      });
    }

    let offset: string | undefined;
    do {
      const page = await this.qdrant.scroll(from, {
        limit: 100,
        offset,
        with_payload: true,
        with_vector: true,
      });

      // P-4 fix: re-embed each point's summary via embedFn rather than copying
      // the source vector. Source vectors are 384-dim (MiniLM); the new collection
      // was created with vectorSize from the probed embedFn, which may differ.
      // Copying mismatched vectors produces a Qdrant VectorDimensionError on every
      // upsert. The summary string is the canonical text for semantic recall; it is
      // always present (backfilled to '' below if absent). For large collections
      // (>10 000 points), consider running migration off-peak; each point incurs one
      // embedding inference call. A future Migration 2→3 may add batched re-embedding.
      const migrated = await Promise.all(page.points.map(async p => {
        const old = p.payload as Record<string, unknown>;
        const successCount = Number(old['successCount'] ?? 0);
        const missCount = 0;
        const summary = String(old['summary'] ?? '');
        const vector = await this.embedFn(summary);
        return {
          id: p.id,
          vector,   // re-embedded — source 384-dim vector discarded
          payload: {
            ...old,
            tenantId,
            tier:             old['tier']  ?? 'episodic',
            scope:            old['scope'] ?? `migrated:${tenantId}`,
            missCount,
            confidence:       successCount / (successCount + missCount + 1),
            lastReinforcedAt: old['lastAccessedAt'] ?? Date.now(),
          } satisfies Partial<MemoryEntry>,
        };
      }));

      if (migrated.length > 0) {
        await this.qdrant.upsert(to, { points: migrated });
      }

      offset = page.next_page_offset as string | undefined;
    } while (offset);

    // Only delete legacy collection after full successful migration
    await this.qdrant.deleteCollection(from);
  }
}
```

---

## 17. BaseAgent Memory Integration

**Replaces** memory-related sections of `BaseAgent` in `§16d.2`.

```typescript
// packages/core-engine/src/agentic/BaseAgent.ts (memory sections)

export class BaseAgent implements IAgent {
  readonly agentId: string;
  readonly memoryScope: string;

  constructor(
    readonly role: AgentRole,
    private readonly llm: ILLMClient,
    private readonly memory: IMemorySystem,
    private readonly userProfileStore: UserProfileStore,
    private readonly systemPrompt: string,
    private readonly trace: LangfuseTraceClient,
    taskId: string,
    private readonly tenantId: string,
    private readonly sessionId: string,
    private readonly userId?: string,      // optional — absent for system-initiated tasks
    private readonly projectId?: string,   // optional — absent for tenant-wide tasks
  ) {
    this.agentId = `${role}-${taskId}`;
    this.memoryScope = `${role}:${taskId}`;
  }

  async process(message: AgentMessage): Promise<AgentMessage> {
    const recalled = await this.memory.recall({
      tenantId:   this.tenantId,
      sessionId:  this.sessionId,
      agentScope: this.memoryScope,
      query:      JSON.stringify(message.payload),
      topK:       5,
      minScore:   0.4,
    });

    const contextLines = recalled
      .map(r => `[${r.tier} score=${r.score.toFixed(2)}] ${r.entry.summary}`)
      .join('\n') || 'none';

    // Load user profile once per process() call — Redis-cached, cheap on hot path
    const profile    = this.userId
      ? await this.userProfileStore.loadProfile(this.tenantId, this.userId)
      : null;
    const userProfile = this.userProfileStore.renderProfile(profile);

    const response = await tracedGeneration(this.trace, {
      operationName: `${this.role}-process`,
      model: 'ollama/llama3',
      promptName: `${this.role}-system-prompt`,
      systemPrompt: this.systemPrompt,
      userPrompt: `
${userProfile ? `${userProfile}\n\n---\n\n` : ''}Recalled context (role: ${this.role}):
${contextLines}

Message from ${message.from}:
${JSON.stringify(message.payload, null, 2)}
      `.trim(),
      responseFormat: 'json',
    }, async (sys, usr) => {
      const res = await this.llm.generate({ systemPrompt: sys, userPrompt: usr, responseFormat: 'json' });
      return { result: res, rawText: res.output, usage: { promptTokens: res.promptTokens, completionTokens: res.completionTokens, totalTokens: res.totalTokens }, durationMs: res.durationMs };
    });

    const parsed = JSON.parse(response.output) as {
      type: 'result' | 'challenge' | 'consensus' | 'escalate';
      payload: unknown;
    };

    // scope is a first-class field — no spread hack
    await this.memory.store({
      tenantId:      this.tenantId,
      userId:        this.userId,
      sessionId:     this.sessionId,
      scope:         this.memoryScope,
      type:          'tool-heuristic',
      tier:          'episodic',
      summary:       `${this.role} decision: ${parsed.type} — ${String(parsed.payload).slice(0, 80)}`,
      detail:        { message, response: parsed },
      relevanceTags: [this.role],
    });

    return {
      id:        randomUUID(),
      from:      this.agentId,
      to:        message.from,
      type:      parsed.type,
      payload:   parsed.payload,
      traceId:   message.traceId,
      timestamp: Date.now(),
    };
  }
}
```

---

## 18. CognitiveEngine Integration

**Replaces** the `consolidateFromTask` call in `CognitiveEngine.processTask()`.

```typescript
// packages/core-engine/src/agentic/CognitiveEngine.ts (memory section)

// At task end — after last sub-goal, before delivery:
const compressed = await this.stmCompressor.compress({
  taskDescription: task.instruction,
  plan: selectedPlan,
  decisions: decisionLog,
});

const taskScope = `${task.taskMode}:${task.id}`;

await Promise.all([
  this.ltm.store({
    tenantId: task.tenantId,
    scope: taskScope,
    type: 'successful-strategy',
    tier: 'episodic',
    summary: compressed.outcomeStatement,
    detail: compressed,
    relevanceTags: compressed.generalizableDecisions.flatMap(d => d.tags),
  }),
  ...compressed.failurePatterns.map(fp =>
    this.ltm.store({
      tenantId: task.tenantId,
      scope: taskScope,
      type: 'failure-pattern',
      tier: 'episodic',
      summary: `${fp.stage}: ${fp.pattern}`,
      detail: fp,
      relevanceTags: [fp.stage],
    })
  ),
]);

// Context pruning runs after each sub-goal (unchanged):
await this.contextPruner.pruneIfNeeded(task.id, trace);
```

---

## 19. ConversationalLoop Integration

```typescript
// packages/core-engine/src/agentic/ConversationalLoop.ts (memory wire-up)

// At the start of run() — before the first agent prompt:
// 1. Load user profile (Redis-cached; fast on hot path).
const userProfile = task.userId
  ? this.userProfileStore.renderProfile(
      await this.userProfileStore.loadProfile(task.tenantId, task.userId)
    )
  : '';

// 2. Warm task memory across four channels (agent + project + STM + tenant).
//    userProfile is intentionally NOT part of warmMemory — it is injected as its own
//    fixed PromptComponents slot so it never competes for warmMemory token budget.
const warmMemory = await this.memorySystem.warmForTask({
  tenantId:        task.tenantId,
  sessionId:       task.sessionId,
  agentScope:      `${agentRole}:${task.id}`,
  taskDescription: task.instruction,
  projectId:       task.projectId,   // enables project-scope recall channel
  maxTokens:       3_000,
});

// 3. Assemble prompt with separated concerns:
const { assembled: systemPrompt, totalTokens, truncations } =
  await this.budgetEnforcer.enforce(task.tenantId, {
    repoMap,
    projectRules,
    skills:              skillsPrefix,
    userProfile,         // always injected; never recalled; never truncated
    warmMemory,          // semantically recalled; evicted third under budget pressure
    conversationHistory,
    systemPrompt:        BASE_SYSTEM_PROMPT,
  });

// After each turn — store turn summary in STM (userId propagated):
await this.memorySystem.store({
  tenantId:      task.tenantId,
  userId:        task.userId,
  sessionId:     task.sessionId,
  scope:         `${agentRole}:${task.id}`,
  type:          'tool-heuristic',
  tier:          'episodic',
  summary:       this.summariseTurn(turn),
  detail:        turn,
  relevanceTags: [task.taskMode, agentRole],
});

// At session end — run in this exact order:
// 1. Preference nudge: review session turns, write detected signals to Postgres.
//    Must run BEFORE endSession() because nudge reads STM warm-layer entries
//    via scrollSession() — endSession() tears them down.
// 2. Session teardown: crash-recovery LTM write if needed, then STM destruction.
await this.preferenceNudge.nudgeAfterSession(task.tenantId, task.userId, task.sessionId);
await this.memorySystem.endSession(task.tenantId, task.sessionId);
```

---

## 20. SessionStore TTL

```typescript
// packages/core-engine/src/agentic/SessionStore.ts (addendum)

export class SessionStore {
  private readonly DEFAULT_TTL_DAYS = 7;

  private async getTtlSeconds(tenantId: string): Promise<number> {
    try {
      const cfg = await this.secrets.getJSON(
        `oweibo/tenants/${tenantId}/memory/session-ttl-days`
      );
      return ((cfg as { days?: number })?.days ?? this.DEFAULT_TTL_DAYS) * 86_400;
    } catch {
      return this.DEFAULT_TTL_DAYS * 86_400;
    }
  }

  // Replace hardcoded SETEX TTL in appendTask():
  async appendTask(tenantId: string, sessionId: string, task: SessionTask): Promise<void> {
    const key = TenantKeyBuilder.session(tenantId, sessionId);
    const ttl = await this.getTtlSeconds(tenantId);
    await this.redis.setex(key, ttl, JSON.stringify(task));
  }
}
```

**Vault path:** `oweibo/tenants/{tenantId}/memory/session-ttl-days`

---

## 21. Bootstrap: ensureCollections

```typescript
// packages/core-engine/src/main.ts (startup bootstrap)

async function ensureMemoryCollections(
  qdrant: QdrantClient,
  tenantIds: string[],
  // P-4 fix: accept embedFn so the collection vector size is determined at runtime
  // from the actual embedding model rather than hardcoded to 1536. Pass the same
  // embedFn instance used by LongTermMemoryStore to guarantee dimension consistency.
  embedFn: (text: string) => Promise<number[]>,
): Promise<void> {
  const existing = await qdrant.getCollections();
  const existingNames = new Set(existing.collections.map(c => c.name));

  // Probe once — all collections for all tenants use the same embedding model.
  const probeVector = await embedFn('collection bootstrap dimension probe');
  const vectorSize = probeVector.length;

  await Promise.all(
    tenantIds.map(async (tenantId) => {
      const name = TenantKeyBuilder.ltmCollection(tenantId);
      if (existingNames.has(name)) return;

      await qdrant.createCollection(name, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });

      for (const field of ['tenantId', 'scope', 'type', 'tier', 'consolidatedAt', 'userId', 'projectId']) {
        await qdrant.createPayloadIndex(name, {
          field_name: field,
          // consolidatedAt is a Unix epoch timestamp (number) when set; the float
          // schema supports Qdrant's is_null filter (used by MemoryConsolidator to
          // exclude already-processed entries) without any schema change — is_null
          // matches points where the field is absent from the payload regardless of
          // its declared schema type.
          // userId and projectId are optional keyword fields; absent when not set.
          field_schema: field === 'consolidatedAt' ? 'float' : 'keyword',
        });
      }
    })
  );
}

// STM VSS indices are created at startup below — one per tenant, covering all sessions.
// LTM collections are bootstrapped above.
// Call order in main.ts: runMigrations → ensureMemoryCollections → ensureStmIndices → startServer

/**
 * ensureStmIndices — creates one Redis Stack HNSW index per tenant if absent.
 *
 * Each index covers all STM entry hashes for that tenant via key PREFIX.
 * Session isolation is enforced at query time via @sessionId TAG filter — there is
 * no per-session index and no collection management.
 *
 * FT.INFO is used to probe existence (throws if the index does not exist).
 * Safe to call on every deploy — idempotent by design.
 *
 * Requires Redis Stack (redis-stack-server ≥ 7.2 or Redis Cloud with Search module).
 * On plain Redis the call() invocations will throw; this function catches and logs
 * those errors so the system starts degraded rather than failing hard — STM warm-layer
 * recall will return empty results until a Redis Stack instance is available.
 */
async function ensureStmIndices(
  redis: Redis,
  tenantIds: string[],
  logger: Logger,
  vectorSize = 1536,
): Promise<void> {
  for (const tenantId of tenantIds) {
    const indexName = TenantKeyBuilder.stmIndex(tenantId);
    const prefix    = TenantKeyBuilder.stmEntryPrefix(tenantId);
    try {
      await (redis as unknown as { call(...a: unknown[]): Promise<unknown> })
        .call('FT.INFO', indexName);
      // Index already exists — nothing to do
    } catch {
      try {
        await (redis as unknown as { call(...a: unknown[]): Promise<unknown> }).call(
          'FT.CREATE', indexName,
          'ON',     'HASH',
          'PREFIX', '1', prefix,
          'SCHEMA',
            'sessionId', 'TAG',           // @sessionId:{id} filter for session isolation
            'tenantId',  'TAG',           // secondary filter for defensive querying
            'role',      'TAG',
            'summary',   'TEXT',
            'tags',      'TEXT',
            'turnIndex', 'NUMERIC', 'SORTABLE',
            'createdAt', 'NUMERIC', 'SORTABLE',
            'embedding', 'VECTOR', 'HNSW', '6',
              'TYPE',            'FLOAT32',
              'DIM',             String(vectorSize),
              'DISTANCE_METRIC', 'COSINE',
        );
        logger.info(`[Bootstrap] Created STM VSS index ${indexName}`);
      } catch (createErr) {
        // Redis Stack unavailable — warm-layer recall degrades to empty results
        logger.warn(`[Bootstrap] Could not create STM VSS index ${indexName} — Redis Stack required`, { createErr });
      }
    }
  }
}
```

---

## 22. Memory CLI

```typescript
// packages/cli/src/commands/memory.ts
// Follows the same pattern as the existing `oweibo skills` subcommands.

const memoryCommand = new Command('memory')
  .description('Inspect and manage agent memory');

// oweibo memory list --tenant <id> [--type <type>] [--tier <tier>] [--top 20]
memoryCommand.command('list')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .option('--type <type>', 'Filter by MemoryType (successful-strategy|failure-pattern|tool-heuristic|domain-knowledge)')
  .option('--tier <tier>', 'Filter by MemoryTier (episodic|semantic|procedural)')
  .option('--top <n>', 'Max results', '20')
  .action(async (opts) => { /* qdrant.scroll() + tabulate */ });

// oweibo memory profile --tenant <id> --user <id>
// Displays the current rendered user profile: structured fields from user_profiles
// and all preference rows from user_preferences, sorted by confidence descending.
// Also shows the rendered XML block that would be injected into the prompt.
memoryCommand.command('profile')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .requiredOption('--user <id>', 'User ID')
  .action(async (opts) => {
    // 1. userProfileStore.loadProfile(tenantId, userId) — bypasses Redis to show live data
    // 2. Display structured fields (displayName, preferredOutputFormat, etc.)
    // 3. Display user_preferences rows: key | value | confidence | updated_at
    // 4. Display rendered <user_profile> XML block that would be injected
    // 5. Show token count vs userProfileTokenCap
  });

// oweibo memory recall --tenant <id> --query "auth strategy" [--top 5]
memoryCommand.command('recall')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .requiredOption('--query <q>', 'Semantic query string')
  .option('--top <n>', 'Max results', '5')
  .action(async (opts) => { /* ltm.recall() + display composite scores */ });

// oweibo memory purge --tenant <id> [--scope <scope>] [--before <ISO>] [--dry-run]
memoryCommand.command('purge')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .option('--scope <scope>', 'Restrict to this scope prefix')
  .option('--before <date>', 'Purge entries created before ISO date')
  .option('--dry-run', 'Preview deletions without applying')
  .action(async (opts) => { /* scroll + conditional delete */ });

// oweibo memory export --tenant <id> --out ./export.jsonl
memoryCommand.command('export')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .requiredOption('--out <path>', 'Output JSONL file path')
  .action(async (opts) => { /* scroll + write JSONL */ });

// oweibo memory doctor --tenant <id>
// Reports: collection size, score distribution, decay candidates, promotion candidates
memoryCommand.command('doctor')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .action(async (opts) => { /* health report + decay preview */ });

// oweibo memory stm-reap --tenant <id> [--dry-run]
// Diagnostic: lists orphaned STM sessions (counter key absent but entry hashes still present).
// Under the Redis VSS model, individual entry hashes expire via native TTL automatically,
// so stm-reap is rarely needed operationally. It is useful for diagnosing sessions that
// were created with a very long TTL and then abandoned without endSession() being called.
memoryCommand.command('stm-reap')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .option('--dry-run', 'Preview deletions without applying')
  .action(async (opts) => {
    // 1. SCAN stm:{tenantId}:*:* to enumerate all entry hashes for this tenant.
    // 2. Extract unique sessionIds from key structure.
    // 3. For each sessionId, check if stm-count:{tenantId}:{sessionId} key exists.
    // 4. If the counter key is absent but entry hashes exist, the session is orphaned.
    // 5. Without --dry-run: DEL all entry hashes for the orphaned sessionId.
  });

// oweibo memory decay --tenant <id> [--dry-run]
memoryCommand.command('decay')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .option('--dry-run', 'Preview without applying')
  .action(async (opts) => { /* manual MemoryDecayService.decayTenant() trigger */ });
```

---

## 23. Infra: K8s CronJobs

```yaml
# infra/k8s/memory-daily-cronjob.yaml
# Runs decay + consolidation + backup as a single daily job at 03:00 UTC.
# concurrencyPolicy: Forbid prevents overlapping cycles.

apiVersion: batch/v1
kind: CronJob
metadata:
  name: memory-daily
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      parallelism: 1
      completions: 1
      template:
        spec:
          containers:
          - name: memory-daily
            image: oweibo/core-engine:latest
            command: ["node", "dist/jobs/memoryDaily.js"]
            env:
            - name: MAX_CONCURRENT_TENANTS
              value: "10"
            - name: MAX_POINTS_PER_TENANT
              value: "2000"
            - name: INTER_BATCH_DELAY_MS
              value: "50"
            resources:
              requests: { memory: "256Mi", cpu: "100m" }
              limits:   { memory: "512Mi", cpu: "500m" }
          restartPolicy: OnFailure
```

```typescript
// packages/core-engine/src/jobs/memoryDaily.ts
// Entry point for the daily CronJob — runs decay, consolidation, and backup in sequence.

async function main(): Promise<void> {
  const { qdrant, pg, s3, secrets, tenantRegistry } = await bootstrap();

  const config = DEFAULT_LTM_CONFIG;
  const tenantIds = () => tenantRegistry.listTenantIds();

  const decay    = new MemoryDecayService(qdrant, pg, config, tenantIds, logger);
  const ltm      = buildLongTermMemoryStore(qdrant, secrets);
  const consolidator = new MemoryConsolidator(qdrant, ltm, modelRouter, llmFactory, logger, metrics, config, secrets);
  const backup   = new LtmBackupService(qdrant, s3, s3Bucket, tenantIds, metrics, logger, config.maxConcurrentTenants);
  // P-4 fix: pass embedFn so migration re-embeds 384-dim source vectors into the
  // correct target dimension instead of copying mismatched vectors.
  const migration = new LtmMigrationService(qdrant, pg, tenantIds, embeddingFn);

  // 1. Idempotent schema migration (no-op if already current)
  await migration.migrate();

  // 2. Decay — evict stale memories; archive to Postgres
  await decay.runDecayCycle();

  // 3. Consolidate — cluster episodics → mint semantic memories
  const tenants = await tenantIds();
  await Promise.all(tenants.map(tid => consolidator.runConsolidationCycle(tid)));

  // 4. Backup — snapshot Qdrant collections to S3
  await backup.runBackupCycle();
}

main().catch(err => { logger.error('Memory daily job failed', { err }); process.exit(1); });
```

---

## 24. Dependency Graph

```
IMemorySystem (interface — core-contracts)
  └── UnifiedMemorySystem (implementation — core-engine)
        ├── ShortTermMemoryStore
        │     ├── HOT layer  — in-process Map<sessionKey, [{embedding, entry}]>
        │     │     └── linear cosine scan, zero I/O, stmHotWindowSize entries; userId stored
        │     ├── WARM layer — Redis Stack HNSW VSS
        │     │     ├── Index  : stm-idx:{tenantId}        [TenantKeyBuilder.stmIndex]
        │     │     ├── Entry  : stm:{tenantId}:{sessionId}:{id} hash + native TTL; userId field
        │     │     ├── Counter: stm-count:{tenantId}:{sessionId} INCR cap enforcement
        │     │     └── Session isolation: @sessionId TAG filter on FT.SEARCH
        │     ├── scrollSession()                          [warm SCAN+HGETALL for crash-recovery]
        │     └── SecretsManager: stm-ttl-seconds
        ├── LongTermMemoryStore
        │     ├── Qdrant: agent-ltm:{tenantId}              [TenantKeyBuilder.ltmCollection]
        │     │     Scopes: user:{userId} · project:{projectId} · tenant:{tenantId} · {role}:{taskId}
        │     │     Indexes: tenantId, scope, type, tier, consolidatedAt, userId, projectId
        │     ├── EmbeddingCache (Redis)
        │     ├── MemoryTracer (Langfuse)                   [wired via constructor — recall spans]
        │     ├── MemoryScopePromoter
        │     │     └── MemoryTracer (Langfuse)
        │     └── SecretsManager: promotion-threshold, governance-scan-enabled
        ├── MemoryWarmer                                     [four-channel recall]
        │     ├── channel 1: agent-scope LTM (AGENT_BOOST=0.10)
        │     ├── channel 2: project-scope LTM (PROJECT_BOOST=0.08) — only when projectId set
        │     ├── channel 3: STM (STM_BOOST=0.06, score normalised to LTM composite scale)
        │     ├── channel 4: tenant-scope LTM (SHARED_BOOST=0.03)
        │     └── ModelRouter.countTokens()
        └── STMCompressor                                   [crash-recovery: compressEntries()]
              ├── ModelRouter.selectModel('summarization')
              └── ILLMClient (small model)

UserProfileStore                                            [prompt concern — injected separately from IMemorySystem]
  ├── Postgres (sole canonical owner of all preference data)
  │     ├── user_profiles   (tenant_id, user_id) → JSONB content  [structured fields]
  │     └── user_preferences (tenant_id, user_id, key) → value, confidence  [UNIQUE on key]
  │           └── upsertPreference() → UPSERT ON CONFLICT (tenant_id, user_id, key)
  ├── Redis: user-profile:{tenantId}:{userId} string key, per-tenant TTL cache
  │     └── TenantKeyBuilder.userProfileKey()
  │     └── invalidated by upsertPreference() and upsertProfileFields()
  ├── ModelRouter.countTokens() — enforces userProfileTokenCap on renderProfile()
  └── NO LongTermMemoryStore dependency — preferences are facts, not vector memories

PreferenceNudgeService                                      [session-end preference detection]
  ├── ShortTermMemoryStore.scrollSession()  — reads warm-layer turns before STM teardown
  ├── UserProfileStore.upsertPreference()   — writes detected signals to Postgres
  ├── ModelRouter.selectModel('summarization') — routes to small model
  ├── ILLMClient (small model)              — NUDGE_SYSTEM_PROMPT, structured JSON output
  ├── Logger + PrometheusClient
  │     └── oweibo_preference_nudge_{sessions,signals,errors}_total
  └── NudgeConfig: minConfidence (0.6), maxTurns (20) — Vault-overridable per-tenant

PromptBudgetEnforcer                                        [mandatory — all prompt assembly sites]
  ├── Prompt chain: repoMap → projectRules → skills → userProfile → warmMemory → conversationHistory → systemPrompt
  ├── Never truncated: systemPrompt, userProfile
  ├── Truncation order: repoMap → conversationHistory → warmMemory → skills → projectRules
  ├── ModelRouter.countTokens()
  └── SecretsManager: prompt-budget (includes userProfile cap: 700 tokens)

STMCompressor                                               [runs at task end, feeds LTM]
  ├── compress()        — normal path (Plan + DecisionLog)
  ├── compressEntries() — crash-recovery path (raw STMEntry[])
  ├── ModelRouter.selectModel('summarization')
  └── ILLMClient (small model)

MemoryDecayService                                          [daily CronJob — LTM only]
  ├── Qdrant: scroll + setPayload + delete
  ├── Postgres: ltm_archive (parameterized INSERT — no interpolation)
  └── pLimit (concurrency cap)

MemoryConsolidator                                          [daily CronJob — LTM only; skips user-preference tier]
  ├── Qdrant: scroll (is_null filter) + setPayload
  ├── LongTermMemoryStore.store()
  ├── clusters all relevanceTags (not just tags[0])
  ├── retry + metric on malformed LLM output
  ├── SecretsManager: oweibo/tenants/{tenantId}/memory/consolidation
  ├── Logger + PrometheusClient
  └── ModelRouter → ILLMClient (small model)

LtmBackupService                                            [daily CronJob — Qdrant LTM only; STM expires via Redis TTL]
  ├── Qdrant: createSnapshot + downloadSnapshot + deleteSnapshot
  ├── S3: putObject
  └── pLimit (maxConcurrentTenants)

LtmMigrationService                                         [startup + daily CronJob — idempotent]
  ├── Qdrant: getCollections + createCollection + createPayloadIndex (incl. userId, projectId) + scroll + upsert + deleteCollection
  └── Postgres: CREATE TABLE ltm_archive, CREATE TABLE user_profiles, CREATE TABLE user_preferences

ensureStmIndices                                            [startup bootstrap — idempotent]
  └── Redis Stack: FT.CREATE stm-idx:{tenantId} (HNSW, FLOAT32, DIM=1536, COSINE) per tenant

TenantKeyBuilder                                            [all storage naming — ESLint enforced]
  ├── ltmCollection()   → agent-ltm:{tenantId}               (Qdrant LTM)
  ├── stmIndex()        → stm-idx:{tenantId}                  (Redis Stack VSS index)
  ├── stmEntryPrefix()  → stm:{tenantId}:                     (FT.CREATE PREFIX)
  ├── stmEntryKey()     → stm:{tenantId}:{sessionId}:{id}     (Redis hash)
  ├── stmCountKey()     → stm-count:{tenantId}:{sessionId}    (Redis INCR cap)
  ├── userProfileKey()  → user-profile:{tenantId}:{userId}    (Redis profile cache)
  ├── userScope()       → user:{userId}                       (LTM scope string)
  ├── projectScope()    → project:{projectId}                 (LTM scope string)
  └── ESLint: no-raw-redis-key + no-raw-scope-string rules

MemoryTracer                                                [all memory operations — Langfuse spans]

SessionStore                                                [per-tenant TTL via Vault]
CLI: oweibo memory {list,recall,purge,export,doctor,profile,stm-reap,decay}
```

---

## 25. Test Coverage

### LTM Core Tests

| Test | Assertion |
|------|-----------|
| **Tenant collection isolation** | Upsert memory for `tenant-a`. Query `agent-ltm:tenant-b` for identical summary. Assert zero results. |
| **Scope field correctness** | Call `store({ scope: 'reviewer:task-1', ... })`. Retrieve point. Assert `payload.scope === 'reviewer:task-1'` — no spread artefacts. |
| **Deduplication** | Store memory. Store near-identical memory (cosine > 0.93, same scope). Assert collection size unchanged; assert original `successCount` incremented. |
| **`reinforce()` no re-embed** | Mock `embedFn`. Call `reinforce(id, tenantId)`. Assert `embedFn` NOT called. Assert `setPayload` called with updated `successCount` and `confidence`. |
| **`penalise()` reduces confidence** | Store memory with `successCount=5, missCount=0` (confidence ≈ 0.83). Call `penalise()`. Assert `missCount=1`, `confidence ≈ 0.71`. |
| **Composite score — recency beats stale** | Insert memory A (high cosine, 30d old, episodic). Insert memory B (lower cosine, 1d old, episodic). Assert B outranks A at default weights. |
| **Composite score — procedural survives recency** | Insert memory A (procedural, 60d old). Insert B (episodic, 5d old, same cosine). Assert A score above eviction threshold; B may be lower. |
| **`minScore` gating** | Insert low-recency, low-success memory. Call `recall()` with `minScore: 0.5`. Assert it is excluded. |
| **Governance scan blocks secrets** | Call `store()` with summary containing `sk-abc123456789012345`. Assert `MemoryGovernanceError` thrown; assert no Qdrant upsert. |
| **Governance scan passthrough** | Call `store()` with clean summary. Assert write succeeds. |
| **`recallForAgent` scope isolation** | Store memories in scope `reviewer:t1` and `architect:t1`. Call `recallForAgent(tenantId, 'reviewer:t1', ...)`. Assert only reviewer memories returned. |

### LTM Decay & Lifecycle Tests

| Test | Assertion |
|------|-----------|
| **Decay eviction** | Insert episodic, `lastReinforcedAt = 30d ago`, `confidence = 0.06`. Run `decayTenant()`. Assert point deleted from Qdrant. Assert row exists in `ltm_archive`. |
| **Decay survival** | Insert procedural (180d half-life), `lastReinforcedAt = 30d ago`, `confidence = 0.8`. Run decay. Assert point survives (effective confidence still above threshold). |
| **Decay cap** | Insert 3000 points. Run decay with `maxPointsPerCyclePerTenant: 2000`. Assert at most 2000 processed; no crash; second cycle processes remainder. |
| **Decay inter-batch delay** | Spy on `setTimeout`. Run decay with 3 batches. Assert `setTimeout` called with `interBatchDelayMs` between each. |
| **Decay tenant concurrency** | Spy on `decayTenant`. Run `runDecayCycle()` with 20 tenants and `maxConcurrentTenants: 5`. Assert no more than 5 concurrent calls at any point. |
| **Archive idempotency** | Archive an entry. Archive same entry again. Assert `ON CONFLICT DO NOTHING` — no error, no duplicate row. |

### LTM Promotion & Consolidation Tests

| Test | Assertion |
|------|-----------|
| **Scope promotion fires at threshold** | Reinforce memory 10 times (default threshold). Assert promoted copy at `scope = 'tenant:{tenantId}'` with `tier = 'procedural'`. Assert original has `promotedToId` set. |
| **Per-tenant promotion threshold** | Mock Vault to return `threshold: 3`. Reinforce 3 times. Assert promotion fires. With default config (10), assert no promotion at 3. |
| **No double-promotion** | Promote a memory (set `promotedToId`). Reinforce again. Assert no second promoted copy created. |
| **Consolidation mints semantic memory** | Insert 4 episodic memories each with `relevanceTags: ['typescript']`. Run `runConsolidationCycle()`. Assert new `semantic` or `procedural` memory written at `scope = 'tenant:{id}'`. Assert originals have `consolidatedAt` set. |
| **Consolidation skips already-consolidated** | Run consolidation twice. Assert LLM called only once per cluster. |
| **Consolidation uses small model** | Assert `modelRouter.selectModel('summarization')` called; assert large model ID never passed to `llmFactory`. |
| **Consolidation truncates oversized cluster** | Pass 100 memories exceeding 8000 chars combined. Assert LLM input is ≤ 8000 chars. |

### Backup & Migration Tests

| Test | Assertion |
|------|-----------|
| **Backup non-fatal per tenant** | Mock `qdrant.createSnapshot` to throw for `tenant-a`. Assert backup continues for `tenant-b`. Assert Prometheus counter incremented for `tenant-a`. |
| **Migration idempotency** | Run migration twice on same tenant. Assert new collection has no duplicate points. Assert legacy collection deleted only on first run. |
| **Migration backfills tier** | Old entry missing `tier` field. Run migration. Assert `payload.tier === 'episodic'` in new collection. |
| **Migration backfills confidence** | Old entry with `successCount: 4`. Run migration. Assert `confidence = 4/5 = 0.8`. |

### STM Tests

| Test | Assertion |
|------|-----------|
| **Hot layer — isolation cross-session** | Store entry for `(tenant-a, session-1)`. Call recall for `(tenant-a, session-2)`. Assert hot layer returns zero results (different hotKey). |
| **Hot layer — isolation cross-tenant** | Store entry for `(tenant-a, session-x)`. Call recall for `(tenant-b, session-x)`. Assert hot layer returns zero results (different hotKey). |
| **Hot layer — window eviction** | Set `stmHotWindowSize: 3`. Store 4 entries in order. Assert hot layer holds exactly 3 entries. Assert the oldest (entry 1) is absent from hot layer (evicted). Assert entry 1 IS present in warm Redis layer. |
| **Hot layer — cosine ranking** | Store entry A (summary "auth token"). Store entry B (summary "database schema"). Query "authentication". Assert entry A outranks entry B in hot recall. |
| **Hot layer — serves recall without I/O** | Mock `redis.call` to throw. Store 3 entries (warm writes will fail; hot writes succeed). Call recall within hot window. Assert results returned without error — hot scan completes even when Redis VSS is unavailable. |
| **Warm layer — isolation cross-session** | Store entry for `(tenant-a, session-1)`. Call `FT.SEARCH` directly with `@sessionId:{session-2}`. Assert zero results. |
| **Warm layer — isolation cross-tenant** | Store entry for `(tenant-a, session-x)`. Query warm layer index `stm-idx:tenant-b` for same query. Assert index does not exist or returns zero results — tenant-a's entries are in `stm-idx:tenant-a` only. |
| **Warm layer — native TTL** | Mock Vault to return `ttl: 3600`. Store entry. Assert `redis.expire` called with `3600` on the entry hash key. Assert `redis.expire` called with `3600` on the counter key. |
| **Warm layer — graceful degradation on plain Redis** | Mock `redis.call('FT.SEARCH', ...)` to throw (Redis Stack unavailable). Call `recall()`. Assert hot layer results returned. Assert no exception propagates. |
| **Session counter cap enforcement** | Set `maxStmEntriesPerSession: 5`. Store 5 entries. Assert 6th store throws `StorageCapExceededError`. Assert counter is NOT left in incremented state after error (decr called). Assert warm layer has exactly 5 entries. |
| **Session counter cap — cross-tenant independent** | Fill `(tenant-a, session-1)` to cap. Call store for `(tenant-b, session-1)`. Assert write succeeds — cap is per (tenantId, sessionId). |
| **destroySession — hot layer cleared** | Store 3 entries (hot layer populated). Call `destroySession()`. Assert hot layer Map entry absent for this session. |
| **destroySession — warm layer cleared** | Store 3 entries (entry hashes written to Redis). Call `destroySession()`. Assert all `stm:{tenantId}:{sessionId}:*` keys deleted from Redis. Assert counter key deleted. |
| **destroySession — idempotent** | Call `destroySession()` on a session that never existed. Assert no error. |
| **scrollSession — returns all warm entries sorted by turnIndex** | Store 5 entries in non-sequential order. Call `scrollSession()`. Assert 5 entries returned sorted ascending by `turnIndex`. |
| **scrollSession — empty on absent session** | Call `scrollSession()` for a session with no entries. Assert empty array returned, no crash. |
| **STM recall hot→warm cascade** | Set `stmHotWindowSize: 2`. Store 4 entries. Call `recall()`. Assert hot results (2 most recent) returned. Assert older 2 entries from warm layer fill remaining slots. Assert no duplicate IDs in merged result. |
| **STM per-tenant TTL via Vault** | Mock Vault to return `ttl: 7200` for tenant-a. Store entry for tenant-a. Assert entry hash key TTL is 7200. |

### UnifiedMemorySystem + MemoryWarmer Tests

| Test | Assertion |
|------|-----------|
| **UnifiedMemorySystem — normalised score merge** | Insert STM entry (raw cosine 0.70). Insert LTM entry (composite 0.60). Call `recall()`. Assert LTM entry outranks STM entry — normalised STM score = 0.60×0.70 + 0.25 = 0.67 < 0.70 composite; LTM wins. Verify no raw cosine value (0.70) appears unwrapped in result scores. |
| **MemoryWarmer — empty returns empty string** | Call `warmForTask()` with empty collections. Assert return `''`. Assert no LLM calls. |
| **MemoryWarmer — injects XML block** | Insert 3 LTM semantic memories. Call `warmForTask()`. Assert return starts with `<warm_memory>` and contains 3 `<memory>` tags. |
| **MemoryWarmer — maxTokens respected** | Set `maxTokens: 100`. Insert 10 memories with long summaries. Assert `<warm_memory>` block is under 100 tokens. |
| **MemoryWarmer — pulls from STM when sessionId provided** | Insert STM entry. Call `warmForTask({ sessionId, ... })`. Assert STM entry appears in XML block. |

### PromptBudgetEnforcer Tests

| Test | Assertion |
|------|-----------|
| **systemPrompt never truncated** | Assemble prompt with all components at max cap. Assert `systemPrompt` in output is byte-for-byte identical to input. |
| **Truncation order — full sequence** | Set budget to admit exactly: systemPrompt + warmMemory + skills + projectRules (no room for repoMap or conversationHistory). Assert `repoMap` absent. Assert `conversationHistory` absent. Assert `warmMemory` present. Assert `skills` present. Assert `projectRules` present. Eviction order: repoMap → conversationHistory → warmMemory → skills → projectRules. |
| **Per-tenant Vault override** | Mock Vault to return `maxTotalTokens: 200_000`. Assert `enforce()` uses 200k budget, not 120k. |
| **Partial fit** | Set remaining budget to 500 tokens. Assert component is included but truncated, with `[truncated by PromptBudgetEnforcer]` suffix. |
| **All truncations — no crash** | Set budget to 0 remaining after systemPrompt. Assert all other components excluded; assert assembled string equals systemPrompt only. |

### TenantKeyBuilder & ESLint Tests

| Test | Assertion |
|------|-----------|
| **`ltmCollection` rejects colon in tenantId** | Call `TenantKeyBuilder.ltmCollection('tenant:x')`. Assert `InvalidTenantIdError`. |
| **`stmIndex` correct format** | Call `TenantKeyBuilder.stmIndex('tenant-a')`. Assert returns `'stm-idx:tenant-a'`. |
| **`stmIndex` rejects invalid tenantId** | Call `TenantKeyBuilder.stmIndex('tenant:x')`. Assert `InvalidTenantIdError`. |
| **`stmEntryKey` correct format** | Call `TenantKeyBuilder.stmEntryKey('t1', 's1', 'e1')`. Assert returns `'stm:t1:s1:e1'`. |
| **`stmEntryKey` rejects slash in sessionId** | Call `TenantKeyBuilder.stmEntryKey('t1', 'sess/x', 'e1')`. Assert `InvalidTenantIdError`. |
| **`stmEntryPrefix` correct format** | Call `TenantKeyBuilder.stmEntryPrefix('t1')`. Assert returns `'stm:t1:'`. |
| **`stmCountKey` correct format** | Call `TenantKeyBuilder.stmCountKey('t1', 's1')`. Assert returns `'stm-count:t1:s1'`. |
| **`stmCountKey` rejects invalid sessionId** | Call `TenantKeyBuilder.stmCountKey('t1', 'sess x')`. Assert `InvalidTenantIdError`. |
| **No two key builders collide** | Generate `stmIndex`, `stmEntryPrefix`, `stmCountKey`, `ltmCollection` for same tenantId. Assert all four strings are distinct and share no ambiguous prefix. |
| **ESLint blocks raw agent-ltm string** | Write TS file containing `` `agent-ltm:${tenantId}` ``. Run ESLint. Assert `no-raw-redis-key` error reported. |
| **ESLint blocks raw agent-stm string** | Write TS file containing `` `agent-stm:${tenantId}` ``. Run ESLint. Assert `no-raw-redis-key` error reported (legacy pattern blocked). |
| **ESLint blocks raw stm-idx string** | Write TS file containing `` `stm-idx:${tenantId}` ``. Run ESLint. Assert `no-raw-redis-key` error reported. |
| **ESLint blocks raw stm-count string** | Write TS file containing `` `stm-count:${tenantId}` ``. Run ESLint. Assert `no-raw-redis-key` error reported. |
| **ESLint passes on TenantKeyBuilder call** | Write TS file using `TenantKeyBuilder.stmIndex(tenantId)` and `TenantKeyBuilder.ltmCollection(tenantId)`. Assert ESLint passes. |

### UserProfileStore & Separation-of-Concerns Tests

| Test | Assertion |
|------|-----------|
| **userProfile never in warmMemory** | Store 3 LTM task-memory entries. Call `warmForTask()`. Assert `<warm_memory>` block contains zero entries sourced from `user_preferences` table (preferences are never in LTM). |
| **userProfile always injected independent of warmMemory** | Set prompt budget so only systemPrompt + userProfile fit (zero room for warmMemory). Call `enforce()`. Assert `userProfile` block present in assembled output. Assert `warmMemory` absent. |
| **userProfile not truncated by enforce()** | Pass `userProfile` content of 580 tokens (below `userProfileTokenCap: 600`). Set total budget barely above systemPrompt + userProfile. Assert `userProfile` present in full, `repoMap` absent. |
| **renderProfile — token cap enforces via preference pruning** | Create profile with 10 preferences; rendered size exceeds `userProfileTokenCap`. Call `renderProfile()`. Assert returned string is within cap. Assert highest-confidence preferences retained. Assert lowest-confidence ones dropped. |
| **renderProfile — null profile returns empty string** | Call `renderProfile(null)`. Assert `''` returned. Assert no empty XML tag injected. |
| **upsertPreference — writes to Postgres, not LTM** | Call `upsertPreference('t1', 'u1', 'language', 'TypeScript', 0.9)`. Assert `pg.query` called with an INSERT containing `ON CONFLICT (tenant_id, user_id, key)`. Assert `LongTermMemoryStore.store` NOT called. Assert LTM not touched. |
| **upsertPreference — UPSERT semantics: no duplicate rows** | Call `upsertPreference()` twice with the same key, different values. Query `user_preferences` table. Assert exactly one row for that key. Assert `value` reflects the second call. Assert `confidence` reflects `GREATEST()` of both calls. |
| **upsertPreference — invalidates Redis cache** | Populate Redis cache for `(t1, u1)`. Call `upsertPreference()`. Assert `user-profile:t1:u1` key deleted from Redis. |
| **upsertPreference — confidence GREATEST: lower does not overwrite higher** | Existing row has `confidence: 0.9`. Call `upsertPreference()` with same key and `confidence: 0.5`. Assert row `confidence` remains `0.9`. |
| **upsertProfileFields — merges JSONB, invalidates cache** | Existing profile has `{ displayName: 'Alice' }`. Call `upsertProfileFields({ skillLevel: 'expert' })`. Assert Postgres row has both fields. Assert Redis cache invalidated. |
| **loadProfile — Redis cache hit, no Postgres query** | Write a profile to Redis. Call `loadProfile()`. Assert `pg.query` NOT called. Assert cached profile returned. |
| **loadProfile — Postgres JOIN returns profile + preferences** | Empty Redis. Write one `user_profiles` row and two `user_preferences` rows. Call `loadProfile()`. Assert returned profile has both preferences. Assert result cached in Redis with correct TTL. |
| **loadProfile — new user returns null** | Empty Redis. Empty Postgres for that user. Call `loadProfile()`. Assert `null` returned. Assert no LTM query. Assert no embedding call. |
| **loadProfile — two-tier only, no LTM fallback** | Empty Redis. Empty Postgres. Spy on any LTM method. Call `loadProfile()`. Assert zero LTM calls. Assert zero embedding calls. |
| **User isolation — preferences not readable across tenants** | Write preference for `(tenant-a, user-1)`. Query `user_preferences` with `tenant-b`. Assert zero rows. |
| **Project-scope recall channel — fires only with projectId** | Insert LTM entry at `scope: 'project:proj-1'`. Call `warmForTask({ projectId: 'proj-1' })`. Assert entry in `<warm_memory>` block. Call `warmForTask({ projectId: undefined })`. Assert entry absent. |
| **Project-scope outranks tenant-scope** | Insert entry A at `scope: 'project:proj-1'` (cosine 0.70). Insert entry B at `scope: 'tenant:t1'` (cosine 0.72). Call `warmForTask({ projectId: 'proj-1' })`. Assert entry A outranks B after PROJECT_BOOST applied. |
| **Project isolation — proj-1 memories absent from proj-2 recall** | Insert entry at `scope: 'project:proj-1'`. Call `warmForTask({ projectId: 'proj-2' })`. Assert entry absent. |
| **userId propagated to STMEntry** | Call `UnifiedMemorySystem.store({ userId: 'u1', ... })`. Assert stored `STMEntry.userId === 'u1'`. |
| **userId propagated to LTM crash-recovery write** | Store 3 STM entries with `userId: 'u1'`. Trigger crash-recovery path in `endSession()`. Assert `LongTermMemoryStore.store()` called with `userId: 'u1'`. |
| **TenantKeyBuilder.userScope rejects invalid userId** | Call `TenantKeyBuilder.userScope('user:x')`. Assert `InvalidTenantIdError` (colon rejected). |
| **TenantKeyBuilder.projectScope rejects invalid projectId** | Call `TenantKeyBuilder.projectScope('proj/1')`. Assert `InvalidTenantIdError` (slash rejected). |
| **ESLint blocks raw user scope construction** | Write TS file containing `` `user:${userId}` ``. Run ESLint. Assert `no-raw-scope-string` warning reported. |
| **ESLint blocks raw project scope construction** | Write TS file containing `` `project:${projectId}` ``. Run ESLint. Assert `no-raw-scope-string` warning reported. |

---

### PreferenceNudgeService Tests

| Test | Assertion |
|------|-----------|
| **nudgeAfterSession — no-op when userId absent** | Call `nudgeAfterSession('t1', undefined, 's1')`. Assert zero STM reads. Assert zero LLM calls. Assert zero Postgres writes. Assert returns 0. |
| **nudgeAfterSession — no-op when session has < 2 entries** | Store 1 STM entry. Call `nudgeAfterSession()`. Assert LLM NOT called. Assert returns 0. |
| **nudgeAfterSession — filters out tool role entries** | Store 2 user entries and 3 tool entries. Assert LLM is called with a transcript containing only the 2 user entries (tool turns excluded). |
| **nudgeAfterSession — LLM called with NUDGE_SYSTEM_PROMPT** | Store 5 entries. Call `nudgeAfterSession()`. Assert `llm.generate` called with `systemPrompt === NUDGE_SYSTEM_PROMPT`. Assert `userPrompt` contains formatted turn transcript with `[Turn N | role]` prefix. |
| **nudgeAfterSession — writes qualifying signals to Postgres** | Mock LLM to return `{ "signals": [{ "key": "language", "value": "TypeScript", "evidence": "User asked twice", "confidence": 0.8 }] }`. Call `nudgeAfterSession()`. Assert `userProfileStore.upsertPreference('t1', 'u1', 'language', 'TypeScript', 0.8)` called. Assert Postgres row written. |
| **nudgeAfterSession — filters signals below minConfidence** | Mock LLM to return two signals: one at confidence 0.8, one at 0.4. Default `minConfidence: 0.6`. Assert `upsertPreference` called exactly once (for the 0.8 signal). Assert the 0.4 signal not written. |
| **nudgeAfterSession — confidence threshold is Vault-configurable** | Construct `PreferenceNudgeService` with `minConfidence: 0.75`. Mock LLM to return signal at confidence 0.7. Assert `upsertPreference` NOT called (0.7 < 0.75 threshold). |
| **nudgeAfterSession — rejects signal with empty evidence** | Mock LLM to return `{ "signals": [{ "key": "format", "value": "bullets", "evidence": "", "confidence": 0.9 }] }`. Assert `upsertPreference` NOT called (evidence is empty — invalid signal). |
| **nudgeAfterSession — malformed LLM output is non-fatal** | Mock LLM to return `"not valid json"`. Call `nudgeAfterSession()`. Assert no exception propagates. Assert `upsertPreference` NOT called. Assert logger.warn called. Assert returns 0. |
| **nudgeAfterSession — LLM error is non-fatal** | Mock LLM to throw. Call `nudgeAfterSession()`. Assert no exception propagates. Assert `oweibo_preference_nudge_errors_total` incremented. Assert returns 0. |
| **nudgeAfterSession — Postgres write error is non-fatal** | Mock `upsertPreference` to throw. Call `nudgeAfterSession()`. Assert no exception propagates. Assert error logged. Assert returns 0. |
| **nudgeAfterSession — respects maxTurns: only last N entries reviewed** | Store 30 STM entries. Construct nudge with `maxTurns: 5`. Assert LLM `userPrompt` contains exactly 5 turns (the last 5). Assert first 25 entries absent from transcript. |
| **nudgeAfterSession — GREATEST confidence via repeated detection** | Call `nudgeAfterSession()` across two sessions for same user: first session writes `language=TypeScript` at confidence 0.7; second session writes same key at confidence 0.9. Query `user_preferences`. Assert `confidence = 0.9` (GREATEST applied across both upserts). |
| **nudgeAfterSession — metrics emitted** | Mock LLM to return 2 qualifying signals. Call `nudgeAfterSession()`. Assert `oweibo_preference_nudge_sessions_total` incremented. Assert `oweibo_preference_nudge_signals_total` incremented. |
| **nudgeAfterSession — zero signals emits sessions metric but not signals metric** | Mock LLM to return `{ "signals": [] }`. Call `nudgeAfterSession()`. Assert `oweibo_preference_nudge_sessions_total` incremented. Assert `oweibo_preference_nudge_signals_total` NOT incremented. |
| **nudgeAfterSession — reads warm layer, not hot layer** | Store entries in warm layer only (hot layer empty after simulated worker restart). Call `nudgeAfterSession()`. Assert LLM still called with session entries (warm-layer SCAN succeeds). |
| **nudge runs before endSession — STM intact during nudge** | Spy on `stm.scrollSession`. Spy on `memorySystem.endSession`. Simulate ConversationalLoop session end. Assert `scrollSession` called BEFORE `endSession`. Assert entries returned (not empty). |
| **nudge does not block endSession on error** | Mock `stm.scrollSession` to throw. Simulate ConversationalLoop session end. Assert `memorySystem.endSession` still called. Assert session torn down normally. |

---

### `user:{userId}` Scope Audit

These tests enforce the contract from §0.2: `scope: 'user:{userId}'` in LTM is reserved for episodic user events only, never preferences. Preferences must go through `UserProfileStore.upsertPreference()` → `user_preferences` Postgres table.

| Test | Assertion |
|------|-----------|
| **No user-preference MemoryType in codebase** | Run TypeScript compilation with strict mode. Assert `'user-preference'` does not appear in the `MemoryType` union (it was removed intentionally — §2). Assert any code assigning `type: 'user-preference'` to a `MemoryEntry` produces a compile-time type error. |
| **user:{userId} LTM scope contains no preference-like entries in production** | Integration test: scan `agent-ltm:{tenantId}` Qdrant collection for all entries with `scope` matching `user:*`. Assert zero entries have `type === 'user-preference'` (type no longer exists). Assert zero entries have `summary` matching `/preference|prefers|always wants|output format/i` — these signals belong in Postgres. |
| **TenantKeyBuilder.userScope() used at all call sites** | Run ESLint `no-raw-scope-string` rule across codebase. Assert zero occurrences of raw `` `user:${...}` `` template literals outside of `TenantKeyBuilder.userScope()`. Assert zero occurrences of `'user:' + ` string concatenation. |
| **userScope call sites write only episodic event types** | Grep all `TenantKeyBuilder.userScope()` call sites. For each call site, assert the `type` field passed to `ltm.store()` is one of `successful-strategy | failure-pattern | tool-heuristic | domain-knowledge` — never `user-preference`. |
| **upsertPreference never calls ltm.store** | Integration test: call `UserProfileStore.upsertPreference()` with a spy on `LongTermMemoryStore.store`. Assert `ltm.store` NOT called during or after `upsertPreference`. Assert write goes only to `user_preferences` Postgres table. |
| **nudge pipeline writes only to Postgres** | Call `PreferenceNudgeService.nudgeAfterSession()` with a spy on `LongTermMemoryStore.store`. Mock LLM to return 3 qualifying signals. Assert `ltm.store` NOT called. Assert `upsertPreference` called 3 times. Assert `user_preferences` table has 3 new rows. |

---

### Residual Recall-Efficiency Gap Tests (R-1 – R-14)

| Test | Assertion | Set budget so only systemPrompt + warmMemory + projectRules fit. Assert `warmMemory` present in assembled output. Assert `repoMap` excluded. |
| **Truncation order — warmMemory evicted after conversationHistory** | Set budget so only systemPrompt + conversationHistory fit. Assert `conversationHistory` present. Assert `warmMemory` excluded. |
| **STM score normalisation** | Insert STM entry (cosine 0.80). Insert LTM entry (composite 0.82, 30d old, episodic). Call `UnifiedMemorySystem.recall()`. Assert LTM entry does NOT outrank STM entry — normalised STM score (0.60×0.80 + 0.25 = 0.73) < 0.82 in this case; assert sort respects the merged scale and no raw-cosine values appear in results. |
| **Cross-tier dedup** | Store identical summary in STM and LTM (simulating a session entry that was also consolidated). Call `UnifiedMemorySystem.recall()`. Assert result set contains exactly one entry for that summary. Assert it is the higher-scored copy. |
| **recallForAgent forwards minScore** | Insert LTM entry with low confidence. Call `recallForAgent()` with `minScore: 0.6`. Assert low-confidence entry excluded. Call with `minScore: 0`. Assert included. |
| **recallForAgent forwards tiers** | Insert episodic and procedural LTM entries in same scope. Call `recallForAgent()` with `tiers: ['procedural']`. Assert only procedural entry returned. |
| **MemoryWarmer — empty STM does not shrink results** | Leave STM empty. Insert 6 LTM entries. Call `warmForTask({ topK: 6, sessionId })`. Assert result contains 6 entries (not 4 from the old hard-quota remainder). |
| **MemoryWarmer — soft-boost: agent scope outranks shared scope** | Insert agent-scope LTM entry (cosine 0.70) and shared-scope LTM entry (cosine 0.72). Call `warmForTask()`. Assert agent-scope entry has higher final score after AGENT_BOOST applied. |
| **MemoryWarmer — STM normalised score comparable to LTM** | Insert STM entry (cosine 0.80). Insert LTM entry (composite 0.82). Verify normalised STM score = 0.60×0.80 + 0.25 + STM_BOOST is computed; assert entries appear in score order in warm block. |
| **LTM recall tracer span emitted** | Construct `LongTermMemoryStore` with a mock `MemoryTracer`. Call `recall()`. Assert `traceRecall` called with name `'ltm'`. |
| **LTM recall updates lastAccessedAt** | Insert entry. Record `lastAccessedAt`. Call `recall()`. Retrieve entry. Assert `lastAccessedAt` is greater than original value. |
| **Consolidation — is_null filter excludes processed entries** | Insert episodic entry. Run consolidation cycle. Assert `consolidatedAt` set. Run cycle again. Assert LLM called only once (entry excluded by `is_null` filter on second run). |
| **Consolidation — multi-tag clustering** | Insert episodic with `relevanceTags: ['typescript', 'auth']`. Insert 2 more with `relevanceTags: ['auth']`. Run consolidation. Assert cluster `auth` has 3 entries (all tagged auth). Assert cluster `typescript` has 1 entry. |
| **Consolidation — retry on malformed JSON** | Mock LLM to return malformed JSON on first call, valid JSON on second. Run consolidation. Assert LLM called twice. Assert semantic memory written. Assert metric NOT incremented. |
| **Consolidation — metric on double-malformed JSON** | Mock LLM to return malformed JSON on both calls. Assert `oweibo_ltm_consolidation_parse_failure_total` incremented. Assert no Qdrant write. Assert `consolidatedAt` NOT set on cluster entries. |
| **Consolidation — windowDays Vault override** | Mock Vault to return `windowDays: 3`. Insert episodic entry 4 days old. Run cycle. Assert entry excluded (outside 3-day window). |
| **Consolidation — minClusterSize Vault override** | Mock Vault to return `minClusterSize: 2`. Insert 2 episodics with same tag. Run cycle. Assert LLM called (threshold met). With default (3), assert LLM NOT called. |
| **archiveEntries — parameterized SQL, no injection** | Call `archiveEntries()` with entry whose `summary` contains `'; DROP TABLE ltm_archive; --`. Assert row inserted without error. Assert `ltm_archive` table still exists and has correct row count. |
| **endSession — crash-recovery writes LTM** | Store 3 STM entries. Call `endSession()` without prior LTM write for the session scope. Assert `LongTermMemoryStore.store()` called with `scope: 'session:{sessionId}'` and `summary` starting with `[crash-recovery]`. Assert STM warm-layer entry hashes deleted and hot layer cleared after. |
| **endSession — no duplicate write if LTM already present** | Store 3 STM entries. Write an LTM entry for `scope: 'session:{sessionId}'` manually. Call `endSession()`. Assert `LongTermMemoryStore.store()` NOT called (normal path already ran). Assert STM still torn down cleanly. |
| **endSession — recovery failure non-fatal** | Mock `STMCompressor.compressEntries` to throw. Call `endSession()`. Assert no exception propagates. Assert STM warm layer and hot layer still torn down. Assert logger.error called. |
| **Backup — concurrency cap** | Spy on `backupTenant`. Call `runBackupCycle()` with 20 tenants and `maxConcurrentTenants: 5`. Assert no more than 5 concurrent calls at any point (mirrors MemoryDecayService concurrency test). |

### Cost / Usage Budget Tests

| Test | Assertion |
|------|-----------|
| **LTM cap blocks write** | Fill a tenant's collection to `maxLtmEntriesPerTenant`. Call `store()`. Assert `LtmCapExceededError` thrown. Assert Qdrant upsert NOT called. Assert existing point count unchanged. |
| **LTM cap not triggered below limit** | Fill collection to `maxLtmEntriesPerTenant - 1`. Call `store()`. Assert write succeeds. |
| **STM session entry cap blocks write** | Set `maxStmEntriesPerSession: 5`. Store 5 entries for `(tenant-a, session-1)`. Assert 6th store throws `StorageCapExceededError`. Assert Redis counter for the session equals 5 after error (decr called). Assert warm layer has exactly 5 entry hashes. |
| **STM session cap — different session unaffected** | Fill `(tenant-a, session-1)` to cap. Call `store()` for `(tenant-a, session-2)`. Assert write succeeds — counter is per (tenantId, sessionId). |
| **STM session cap — different tenant unaffected** | Fill `(tenant-a, session-1)` to cap. Call `store()` for `(tenant-b, session-1)`. Assert write succeeds — counter is per-tenant. |
| **STM session cap — counter shares TTL** | Mock Vault to return `ttl: 3600`. Store 3 entries. Assert counter key `stm-count:{tenantId}:{sessionId}` has TTL ≤ 3600 seconds in Redis. |
| **Consolidation cluster cap — largest clusters run first** | Mock 25 clusters; sizes 1–25 (only those ≥ minClusterSize=3 qualify). Set `maxClustersPerCycle: 5`. Run cycle. Assert LLM called exactly 5 times. Assert the 5 called clusters are the 5 largest. |
| **Consolidation cluster cap — metric emitted** | Set `maxClustersPerCycle: 3` with 10 qualifying clusters. Run cycle. Assert `oweibo_ltm_consolidation_cluster_cap_total` incremented exactly once. Assert logger.warn called with `total`, `processed`, `cap` fields. |
| **Consolidation cluster cap — Vault override** | Mock Vault to return `maxClustersPerCycle: 2`. Assert only 2 LLM calls fired regardless of default config value. |
| **stm-reap dry-run** | Store 2 sessions with no counter key (simulating abandoned sessions with long-TTL entry hashes). Run `oweibo memory stm-reap --dry-run --tenant t1`. Assert zero Redis DEL calls on entry hashes. Assert stdout lists orphaned sessionIds. |
| **stm-reap live** | Create 2 orphaned sessions (counter key absent, entry hashes present) and 1 live session (counter key present). Run `oweibo memory stm-reap --tenant t1`. Assert all entry hashes for the 2 orphaned sessions deleted. Assert live session entry hashes untouched. |

---

### Stress Tests — 50–100 Tenant Concurrency

These tests run against a real (test-environment) Qdrant and Redis instance, not mocks. They are tagged `@stress` and excluded from the standard CI run; they execute in a dedicated nightly stress pipeline.

| Test | Setup | Assertion |
|------|-------|-----------|
| **Concurrent recall isolation — 100 tenants** | Provision 100 tenant LTM collections, each with 200 seeded memories. Fire 100 concurrent `recall()` calls, one per tenant, all with the same query string. | Assert every result set contains only entries belonging to its own `tenantId`. Assert zero cross-tenant entries in any result. Assert all 100 calls complete within 5 seconds wall time. |
| **Concurrent store + recall — no data bleed** | 50 tenants simultaneously calling `store()` and `recall()` in a tight loop (10 iterations each) for 10 seconds. | Assert final collection for each tenant contains only that tenant's entries (verified by `tenantId` field on every point). Assert no `LtmCapExceededError` for any tenant (entry counts stay well below cap). |
| **Concurrent STM session isolation — 100 sessions across 10 tenants** | 100 sessions (10 per tenant, each with a distinct sessionId) concurrently calling `ShortTermMemoryStore.store()` and `recall()`. | Assert each session's hot-layer recall returns only its own entries (hotKey is per session). Assert warm-layer FT.SEARCH with `@sessionId:{id}` filter returns only that session's entries. Assert no `StorageCapExceededError` (10 sessions × entries per session is well below `maxStmEntriesPerSession: 500`). Assert Redis key space contains no cross-tenant entry hashes (SCAN `stm:tenant-a:*` returns only tenant-a keys). |
| **Concurrent daily cycle — 50 tenants, decay + consolidation + backup** | 50 tenant LTM collections seeded with 500 episodic entries each (250 decayable, 250 consolidatable in 5 clusters of 50). Run `MemoryDecayService.runDecayCycle()`, `MemoryConsolidator.runConsolidationCycle()` for all tenants, and `LtmBackupService.runBackupCycle()` concurrently (as the daily CronJob does). | Assert `p-limit` holds: never more than `maxConcurrentTenants: 10` active in any service at once (verified by spy counting peak concurrent invocations). Assert every tenant's decayable entries are evicted. Assert each tenant produces exactly `min(qualifyingClusters, maxClustersPerCycle)` semantic memories. Assert no cross-tenant data in any collection post-cycle. Assert backup metric shows 0 failures. |
| **Daily cycle + concurrent agent tasks — no deadlock or data corruption** | 50 tenants each running a simulated agent task (10 `store()` + 5 `recall()` calls over 2 seconds) while the daily decay + consolidation cycle runs simultaneously against the same collections. | Assert no deadlock (all operations complete within 30 seconds). Assert no entry written by an agent task appears in another tenant's collection. Assert `consolidatedAt` is set only on entries that existed before the consolidation cycle started — entries written mid-cycle are not incorrectly marked. Assert `LtmCapExceededError` is NOT thrown (active writes are well below cap). |
| **STM session entry cap enforcement at scale** | Simulate 600 concurrent store calls for a single session `(tenant-a, session-x)` with `maxStmEntriesPerSession: 500`. | Assert exactly 500 stores succeed (counter reaches 500). Assert the remaining 100 receive `StorageCapExceededError`. Assert Redis counter for the session equals 500. Assert the number of `stm:{tenantId}:{sessionId}:*` entry hash keys in Redis equals 500. Assert other sessions on the same tenant are unaffected. |
| **LTM cap enforcement under concurrent writes** | 20 concurrent goroutines each writing to the same tenant's LTM collection; collection is pre-seeded to `maxLtmEntriesPerTenant - 5`. | Assert no more than 5 writes succeed (the remaining capacity). Assert all subsequent writes throw `LtmCapExceededError`. Assert final collection point count equals exactly `maxLtmEntriesPerTenant`. (Note: a small over-shoot window exists because `getCollection().points_count` and `upsert` are not atomic — this test documents the acceptable race window and asserts it is bounded to `batchSize: 100` entries maximum.) |
| **Background job tenant concurrency cap — 100 tenants** | Register 100 tenants. Run `MemoryDecayService.runDecayCycle()`. Spy on `decayTenant()` invocation timing. | Assert peak concurrent invocations never exceed `maxConcurrentTenants: 10` at any sampled 100ms window. Assert all 100 tenants are processed within the cycle (no tenants silently skipped). |
| **Redis key space isolation — TenantKeyBuilder VSS keys** | Generate `stmEntryKey`, `stmCountKey`, `stmIndex`, and `stmEntryPrefix` for 100 tenants × 50 sessions each. | Assert no two different (tenantId, sessionId) pairs produce a colliding `stmEntryKey` prefix. Assert all entry keys for `tenant-a` start with `stm:tenant-a:`. Assert SCAN `stm:tenant-a:*` on a Redis instance with all 5000 sessions seeded returns only tenant-a keys. Assert no entry key for any tenant matches another tenant's `stmIndex` or `stmCountKey` pattern. |
| **Redis key space isolation — 100 tenants × 50 sessions** | Write 10 STM entry hashes per session for 100 tenants × 50 sessions (50,000 keys). Write corresponding counter keys. | Assert every entry hash key matches `stm:{tenantId}:{sessionId}:{uuid}` with no ambiguous prefix overlaps between tenants. Assert SCAN `stm:tenant-a:*` returns exactly 500 keys (10 entries × 50 sessions) — none from other tenants. Assert SCAN `stm-count:tenant-a:*` returns exactly 50 counter keys — none from other tenants. Assert deleting all keys for `tenant-a` via `destroySession` across all 50 sessions does not affect any other tenant's keys. |


### CLI Tests

| Test | Assertion |
|------|-----------|
| **`purge --dry-run` makes no deletes** | Run `oweibo memory purge --dry-run --tenant t1`. Assert zero Qdrant delete calls. Assert stdout describes what would be deleted. |
| **`doctor` reports collection size** | Run `oweibo memory doctor --tenant t1`. Assert output includes point count and tier distribution. |
| **`export` writes valid JSONL** | Run `oweibo memory export --tenant t1 --out /tmp/test.jsonl`. Assert file exists. Assert each line parses as valid `MemoryEntry` JSON. |

---

## 26. Kilo Pipeline Integration

This section implements the six gaps identified in §1.6 (P-1 through P-6). All changes are confined to `kilo/pipeline/src/` and the `PipelineMemoryAdapter` bridge module. No changes are made to `packages/core-engine` beyond the `LtmMigrationService` and `ensureMemoryCollections` fixes already applied in §16 and §21.

### 26.1 invariants.yaml — Remove as Write Target (P-1)

**Root cause:** `kilo/pipeline/src/services/promotion/engine.js` line 52 calls `fs.appendFileSync` to write new invariants into `invariants.yaml`. `kilo/pipeline/src/services/promotion/decay.js` lines 59–64 rewrites the same file via a `tmp+rename` pattern. Under concurrent pipeline workers — or when a decay run races a promotion write — these two write strategies conflict. `appendFileSync` is only POSIX-atomic for writes under `PIPE_BUF` (~4 KB); larger invariant blocks and concurrent rename operations silently corrupt the file.

**Fix:** `project_invariants` in Qdrant is already the authoritative store. `invariants.yaml` is retained as a human-readable inspection file but is no longer written by the pipeline at runtime.

**Changes to `engine.js`:**

```javascript
// REMOVE the entire block that writes to invariants.yaml after qdrant.upsert().
// Before (lines 48–52 in engine.js):
//   const content = type === 'det_invariant' ? `\n- id: ...` : `\n- id: ...`;
//   fs.appendFileSync(invFile, content);
// After: delete those lines. Qdrant upsert already happened above — that is the
// canonical write. The YAML file is not consulted at runtime by any gate runner.
```

**Changes to `decay.js`:**

```javascript
// REMOVE calls to removeFromYaml(invFile, inv.id) and writeToStaging(inv, workspacePath).
// Both functions write to filesystem paths. Replace with Qdrant-only operations:
//   - removeFromYaml  → already handled by qdrant.delete() above it in the same block
//   - writeToStaging  → replace with qdrant.upsert('project_invariants', demotedPoint)
//     where demotedPoint has halved confidence, new UUID, and demotion metadata in payload.
// The .kilo/staging/ directory is no longer written by decay. The promotion engine
// (engine.js) reads staging from Qdrant scroll on project_invariants with a
// filter: { must: [{ key: 'status', match: { value: 'staging' } }] }.
```

**New `oweibo memory export-invariants` CLI command** (addendum to §22):

```typescript
// oweibo memory export-invariants --tenant <id> --out ./invariants.yaml
memoryCommand.command('export-invariants')
  .requiredOption('--tenant <id>', 'Tenant ID')
  .option('--out <path>', 'Output YAML path', '.kilo/invariants.yaml')
  .action(async (opts) => {
    // Scroll project_invariants for this tenant; write YAML for human inspection.
    // This is the ONLY writer of invariants.yaml — called on demand, never at runtime.
  });
```

**Staging payload schema extension** — add `status: 'staging' | 'active'` field to invariant Qdrant payloads so the promotion engine can scroll active vs. staging entries without relying on filesystem paths.

---

### 26.2 Gate Feedback Wiring: reinforce / penalise (P-2)

**Root cause:** `decay.js` reads `false_positive_count` and `hit_count` from Qdrant invariant payloads for quality-based demotion. Nothing in the pipeline ever writes these fields after initial creation. The quality-based decay branch (`fpRate > fpThreshold`) is therefore functionally dead — all invariants have `false_positive_count: 0`.

**Two feedback events that must be wired:**

**1. Reinforce — invariant was useful (task passed all gates, no ladder retries)**

```javascript
// kilo/pipeline/src/services/gates/invariantSemantic.js
// kilo/pipeline/src/services/gates/invariantDeterministic.js
// At the end of each gate runner, after a task successfully passes, call:

async function reinforcePassedInvariants(tenantId, firedInvariantIds, memoryAdapter) {
  await Promise.allSettled(
    firedInvariantIds.map(id => memoryAdapter.reinforce(id, tenantId))
  );
}
// firedInvariantIds are the Qdrant point IDs of invariants that were evaluated
// and whose check passed in this gate run. Collect them during the gate sweep.
// allSettled: a reinforce failure must not block the pipeline stage.
```

**2. Penalise — invariant fired but task was promoted by human override**

```javascript
// kilo/pipeline/src/routes/staging.js (human promotion endpoint)
// When a task is promoted despite gate failures (supervised mode override):

async function penaliseFalsePositiveInvariants(tenantId, quarantinedInvariantIds, memoryAdapter) {
  await Promise.allSettled(
    quarantinedInvariantIds.map(id => memoryAdapter.penalise(id, tenantId))
  );
}
// quarantinedInvariantIds come from the task's quarantine record, which already
// stores gates_failed[] with the invariant IDs that blocked promotion.
// The human-approval route calls this before writing to project_decisions.
```

**Where IDs come from:** Gate runners store fired invariant Qdrant point IDs in the task checkpoint at `checkpointDir/gate_results.json` alongside pass/fail status. The staging promotion route reads this file to populate `quarantinedInvariantIds`. This file is already partially written by gate runners — it needs a `fired_invariant_ids` field added.

---

### 26.3 project_context Collection Retirement (P-3)

**Root cause:** `COLLECTION_CONFIG.project_context` in `memory.js` uses `threshold: 0, limit: 50`, injecting up to 50 unfiltered entries into every prompt. On `qwen2.5-coder:1.5b` (~4 K context tokens), this exhausts the entire context window before the task instruction.

**Migration — one-time, run via `LtmMigrationService` (new `runMigration2to3`):**

```typescript
// packages/core-engine/src/jobs/LtmMigrationService.ts
// Add to migrateTenant():
// if (names.has('project_context') && schemaVersion < 3) await this.runMigration2to3(tenantId);

private async runMigration2to3(tenantId: string): Promise<void> {
  const unified = TenantKeyBuilder.ltmCollection(tenantId);
  // Scroll project_context; re-embed and upsert into unified collection as semantic entries.
  let offset: string | undefined;
  do {
    const page = await this.qdrant.scroll('project_context', {
      limit: 100, offset, with_payload: true, with_vector: false,
    });
    const points = await Promise.all(page.points.map(async p => {
      const old = p.payload as Record<string, unknown>;
      const summary = String(old['content'] ?? old['text'] ?? '');
      const vector = await this.embedFn(summary);
      return {
        id: randomUUID(),
        vector,
        payload: {
          tenantId,
          scope: `tenant:${tenantId}`,
          type: 'domain-knowledge' as const,
          tier: 'semantic' as const,
          summary: summary.slice(0, 500),
          detail: old,
          relevanceTags: ['context', 'migrated-from-project_context'],
          successCount: 0, missCount: 0, confidence: 0.5,
          createdAt: Date.now(), lastAccessedAt: Date.now(), lastReinforcedAt: Date.now(),
        },
      };
    }));
    if (points.length > 0) await this.qdrant.upsert(unified, { points });
    offset = page.next_page_offset as string | undefined;
  } while (offset);
  // Delete legacy collection only after full successful migration
  await this.qdrant.deleteCollection('project_context');
}
```

**Runtime change in `memory.js`:** Remove `project_context` from `COLLECTION_CONFIG`. The content is now served by `MemoryWarmer`'s tenant-scope channel (`scope: 'tenant:{tenantId}'`, `minScore: 0.45`), which is already subject to `PromptBudgetEnforcer`'s token budget.

---

### 26.4 Embedding Dimension — Hardware Profile Strategy (P-4)

The code fixes for the vector dimension mismatch are applied in §16 (`LtmMigrationService`) and §21 (`ensureMemoryCollections`). This section specifies the recommended embedding model per hardware profile so operators can configure `EMBED_MODEL` before running migration.

| Hardware Profile | RAM | Recommended Model | Dim | Ollama Model ID |
| --- | --- | --- | --- | --- |
| Raspberry Pi 4 | 4 GB | all-MiniLM-L6-v2 (CPU, Xenova) | 384 | *(bundled via `@xenova/transformers`)* |
| Intel N-Series | 8 GB | nomic-embed-text | 768 | `nomic-embed-text` |
| Mid-Range | 16 GB | mxbai-embed-large | 1024 | `mxbai-embed-large` |
| High-End | 32 GB+ | nomic-embed-text-v1.5 | 768 | `nomic-embed-text-v1.5` |

**Important:** Choosing a new embedding model requires re-running migration (`runMigration1to2`) against all existing collections. All existing 384-dim vectors are discarded and re-embedded. Schedule migration during a maintenance window; embedding 10 000 points takes approximately 2–8 minutes on N-Series hardware at 768-dim.

**Configuration (`.env` / `config.env`):**

```bash
# Embedding model — must match the model used when collections were created.
# Changing this value after collections exist requires running migration again.
EMBED_MODEL=nomic-embed-text     # N-Series default
EMBED_DIM=768                    # informational — actual dim probed at runtime
```

**`embeddings.js` addendum:** Add `EMBED_MODEL` config support alongside the existing `Xenova/all-MiniLM-L6-v2` path. When `EMBED_MODEL` is set to an Ollama model ID, route embedding calls through `ollama.embeddings()` instead of `@xenova/transformers`.

---

### 26.5 Pipeline Stage STM Writes (P-5)

**Root cause:** The 9-stage kilo pipeline stages communicate only via checkpoint files. No stage writes semantic summaries to `IMemorySystem`, so the agent cannot semantically recall what the Architect decided when the Executor runs, and subsequent tasks for the same tenant have no access to intra-task reasoning.

**Write points** — each stage boundary calls `memoryAdapter.storeStageOutput()`:

```javascript
// kilo/pipeline/src/services/executor.js — after runArchitect() returns:
await memoryAdapter.storeStageOutput({
  tenantId: task.tenantId,
  taskId:   task.id,
  stage:    'architect',
  summary:  `Architecture plan generated: ${plan.slice(0, 200)}`,
  detail:   { planLength: plan.length, exitCode },
});

// After runOrchestrate() returns:
await memoryAdapter.storeStageOutput({
  tenantId: task.tenantId,
  taskId:   task.id,
  stage:    'orchestrate',
  summary:  `Orchestration ${route}: exit ${exitCode}`,
  detail:   { route, exitCode },
});
```

```javascript
// kilo/pipeline/src/services/gates/staticGates.js — after each gate run:
await memoryAdapter.storeStageOutput({
  tenantId: task.tenantId,
  taskId:   task.id,
  stage:    'static-gate',
  summary:  `Static gate ${gateId}: ${passed ? 'passed' : 'failed'}`,
  detail:   { gateId, passed, findings: findings.slice(0, 10) },
});
```

**`storeStageOutput` in `PipelineMemoryAdapter`:**

```javascript
async storeStageOutput({ tenantId, taskId, stage, summary, detail }) {
  return this.memorySystem.store({
    tenantId,
    sessionId:     taskId,          // task is the session in pipeline context
    scope:         `pipeline:${taskId}`,
    type:          'tool-heuristic',
    tier:          'episodic',
    summary,
    detail,
    relevanceTags: [stage, tenantId],
  });
}
```

**Recall by downstream stages:**

```javascript
// Any stage that needs prior-stage context:
const priorContext = await memoryAdapter.recallStageContext({
  tenantId, taskId, query: 'architecture decisions',
});
```

**LTM write at task end:** `PipelineMemoryAdapter.finalizeTask()` calls `memorySystem.endSession(tenantId, taskId)`. The `UnifiedMemorySystem.endSession()` crash-recovery path compresses all stage STM entries into one LTM episodic entry under `scope: 'session:{taskId}'` if no LTM write was made during the task. For successfully completed tasks, `CognitiveEngine`-equivalent logic in the pipeline calls `stmCompressor.compress()` at the end of stage 9 (Promotion) and writes to LTM explicitly.

---

### 26.6 JS Pipeline → TypeScript IMemorySystem Bridge (P-6)

**Root cause:** `kilo/pipeline/src/services/memory.js` calls `qdrant.search()` and `embeddings.embed()` directly. It bypasses all guarantees from §§2–25: no tenant isolation enforcement via `TenantKeyBuilder`, no `PromptBudgetEnforcer`, no composite scoring, no false-positive tracking, no governance scan.

**Bridge design:** `PipelineMemoryAdapter` is a new CommonJS module at `kilo/pipeline/src/services/pipelineMemoryAdapter.js`. It imports the compiled CJS output of `packages/core-engine` and wraps `UnifiedMemorySystem` in the pipeline's error handling conventions.

```javascript
// kilo/pipeline/src/services/pipelineMemoryAdapter.js
'use strict';

// Requires packages/core-engine to be compiled to CJS before pipeline startup.
// Add to kilo/pipeline/package.json scripts:
//   "prebuild": "cd ../../packages/core-engine && npm run build"
// Or in docker-compose.yml: build core-engine image first; install as a local
// file dependency: "file:../../packages/core-engine" in pipeline package.json.

const {
  UnifiedMemorySystem,
  ShortTermMemoryStore,
  LongTermMemoryStore,
  MemoryWarmer,
  STMCompressor,
} = require('@oweibo/core-engine');

const { TenantKeyBuilder } = require('@oweibo/core-engine/infra');
const logger = require('./logger');
const config = require('../config');

let memorySystem = null;

/**
 * Initialize UnifiedMemorySystem.
 * Called once at pipeline startup alongside qdrant.initialize() and embeddings.initialize().
 * Must be awaited before any request handler runs.
 *
 * @param {object} deps
 * @param {object} deps.qdrantClient   — @qdrant/js-client-rest QdrantClient
 * @param {object} deps.redisClient    — ioredis Redis (Redis Stack for warm STM layer)
 * @param {Function} deps.embedFn      — (text: string) => Promise<number[]>
 * @param {object} deps.modelRouter    — ModelRouter instance
 * @param {Function} deps.llmFactory   — (modelId: string) => ILLMClient
 * @param {object} deps.secrets        — SecretsManager instance
 */
async function initialize({ qdrantClient, redisClient, embedFn, modelRouter, llmFactory, secrets }) {
  const ltmConfig = {
    ...DEFAULT_LTM_CONFIG,
    stmHotWindowSize:           config.STM_HOT_WINDOW_SIZE         ?? 50,
    maxStmEntriesPerSession:    config.MAX_STM_ENTRIES_PER_SESSION  ?? 500,
    maxLtmEntriesPerTenant:     config.MAX_LTM_ENTRIES_PER_TENANT   ?? 100_000,
  };

  const stm = new ShortTermMemoryStore(redisClient, embedFn, ltmConfig, secrets);
  const ltm = new LongTermMemoryStore(qdrantClient, embedFn, redisClient, ltmConfig, secrets);
  const warmer = new MemoryWarmer(ltm, stm, modelRouter);
  const compressor = new STMCompressor(modelRouter, llmFactory);

  memorySystem = new UnifiedMemorySystem(stm, ltm, warmer, compressor, logger);

  logger.info('[PipelineMemoryAdapter] UnifiedMemorySystem initialized');
}

/**
 * Drop-in replacement for the existing retrieveMemory(taskId, instruction, tenantId)
 * call in kilo/pipeline/src/services/memory.js.
 * Returns the same formatted MEMORY CONTEXT BLOCK string so all callers need no changes.
 */
async function retrieveMemory(taskId, instruction, tenantId) {
  if (!memorySystem) throw new Error('PipelineMemoryAdapter not initialized');
  return memorySystem.warmForTask({
    tenantId,
    sessionId:       taskId,
    agentScope:      `pipeline:${taskId}`,
    taskDescription: instruction,
    maxTokens:       config.MEMORY_CONTEXT_MAX_TOKENS ?? 2_000,
  });
}

async function storeStageOutput({ tenantId, taskId, stage, summary, detail }) {
  if (!memorySystem) return;
  try {
    await memorySystem.store({
      tenantId,
      sessionId:     taskId,
      scope:         `pipeline:${taskId}`,
      type:          'tool-heuristic',
      tier:          'episodic',
      summary,
      detail,
      relevanceTags: [stage],
    });
  } catch (err) {
    // Non-fatal: pipeline must not stall on memory write failures
    logger.warn('[PipelineMemoryAdapter] storeStageOutput failed', { stage, taskId, error: err.message });
  }
}

async function recallStageContext({ tenantId, taskId, query, topK = 5 }) {
  if (!memorySystem) return [];
  try {
    return await memorySystem.recall({
      tenantId,
      sessionId:  taskId,
      agentScope: `pipeline:${taskId}`,
      query,
      topK,
      minScore:   0.35,
    });
  } catch (err) {
    logger.warn('[PipelineMemoryAdapter] recallStageContext failed', { taskId, error: err.message });
    return [];
  }
}

async function reinforce(memoryId, tenantId) {
  if (!memorySystem) return;
  try { await memorySystem.reinforce(memoryId, tenantId); } catch (err) {
    logger.warn('[PipelineMemoryAdapter] reinforce failed', { memoryId, error: err.message });
  }
}

async function penalise(memoryId, tenantId) {
  if (!memorySystem) return;
  try { await memorySystem.penalise(memoryId, tenantId); } catch (err) {
    logger.warn('[PipelineMemoryAdapter] penalise failed', { memoryId, error: err.message });
  }
}

async function finalizeTask(tenantId, taskId) {
  if (!memorySystem) return;
  try { await memorySystem.endSession(tenantId, taskId); } catch (err) {
    logger.warn('[PipelineMemoryAdapter] finalizeTask failed', { taskId, error: err.message });
  }
}

module.exports = {
  initialize,
  retrieveMemory,
  storeStageOutput,
  recallStageContext,
  reinforce,
  penalise,
  finalizeTask,
};
```

**Wire-up in `kilo/pipeline/src/index.js`:**

```javascript
// Replace: const memory = require('./services/memory');
// With:
const memoryAdapter = require('./services/pipelineMemoryAdapter');

// In the startup sequence alongside qdrant.initialize() and embeddings.initialize():
await memoryAdapter.initialize({
  qdrantClient: qdrant.getClient(),
  redisClient:  redis,
  embedFn:      embeddings.embed,
  modelRouter,
  llmFactory,
  secrets,
});
```

**`kilo/pipeline/src/services/memory.js` migration:** Replace `retrieveMemory` with a thin re-export:

```javascript
// kilo/pipeline/src/services/memory.js — DEPRECATED SHIM
// All logic moved to pipelineMemoryAdapter.js.
// This file is kept temporarily to avoid breaking imports in routes that call
// require('./services/memory').retrieveMemory(). Remove after all callers are updated.
'use strict';
const adapter = require('./pipelineMemoryAdapter');
module.exports = { retrieveMemory: adapter.retrieveMemory };
```

**Dependency resolution:** `packages/core-engine` must be compiled before the pipeline starts. Add to `kilo/pipeline/Dockerfile`:

```dockerfile
# Build core-engine TypeScript before pipeline dependencies
COPY packages/core-engine /app/packages/core-engine
RUN cd /app/packages/core-engine && npm ci && npm run build

# Install pipeline with file: dependency on compiled core-engine
COPY kilo/pipeline /app/kilo/pipeline
RUN cd /app/kilo/pipeline && npm ci
```

And in `kilo/pipeline/package.json`:

```json
{
  "dependencies": {
    "@oweibo/core-engine": "file:../../packages/core-engine"
  }
}
```

---

### 26.7 Kilo Pipeline Integration Tests

| Test | Assertion |
| --- | --- |
| **PipelineMemoryAdapter — retrieveMemory returns warm memory block** | Initialize adapter with mock `UnifiedMemorySystem`. Call `retrieveMemory('task-1', 'refactor auth module', 'tenant-a')`. Assert `memorySystem.warmForTask` called with `{ tenantId: 'tenant-a', sessionId: 'task-1', agentScope: 'pipeline:task-1', taskDescription: 'refactor auth module' }`. Assert returned string is non-empty. |
| **PipelineMemoryAdapter — retrieveMemory respects token cap from config** | Set `MEMORY_CONTEXT_MAX_TOKENS: 1500`. Call `retrieveMemory()`. Assert `warmForTask` called with `maxTokens: 1500`. |
| **PipelineMemoryAdapter — storeStageOutput is non-fatal on failure** | Mock `memorySystem.store` to throw. Call `storeStageOutput()`. Assert no exception propagates. Assert `logger.warn` called. |
| **PipelineMemoryAdapter — recallStageContext returns empty array on failure** | Mock `memorySystem.recall` to throw. Call `recallStageContext()`. Assert empty array returned. Assert no exception propagates. |
| **PipelineMemoryAdapter — reinforce non-fatal** | Mock `memorySystem.reinforce` to throw. Call `reinforce('id', 'tenant')`. Assert no exception propagates. Assert `logger.warn` called. |
| **PipelineMemoryAdapter — penalise non-fatal** | Mock `memorySystem.penalise` to throw. Call `penalise('id', 'tenant')`. Assert no exception propagates. Assert `logger.warn` called. |
| **PipelineMemoryAdapter — finalizeTask calls endSession** | Call `finalizeTask('tenant-a', 'task-1')`. Assert `memorySystem.endSession('tenant-a', 'task-1')` called. |
| **Gate feedback — reinforce called after clean pass** | Simulate a task passing `invariantSemantic` gate with `firedInvariantIds: ['uuid-1', 'uuid-2']`. Assert `memoryAdapter.reinforce` called twice, once per ID. Assert no penalise calls. |
| **Gate feedback — penalise called on human override** | Simulate supervised-mode staging promotion with `quarantinedInvariantIds: ['uuid-3']`. Assert `memoryAdapter.penalise('uuid-3', tenantId)` called exactly once. Assert reinforce NOT called. |
| **Gate feedback — reinforce/penalise written to Qdrant payload** | Integration test: store invariant in `project_invariants`. Call reinforce 3 times via adapter. Retrieve point. Assert `successCount === 3`. Call penalise once. Assert `missCount === 1`. Assert `confidence === 3 / (3 + 1 + 1) = 0.6`. |
| **invariants.yaml — no runtime write** | Run `engine.js` `evaluateStaging()` to promote an invariant. Assert `fs.appendFileSync` NOT called. Assert Qdrant `upsert` called with `project_invariants`. Assert `invariants.yaml` file not modified. |
| **invariants.yaml — export-invariants writes YAML** | Seed 3 invariants in `project_invariants` Qdrant collection. Run `oweibo memory export-invariants --tenant t1 --out /tmp/test.yaml`. Assert file exists. Assert all 3 invariant IDs appear in YAML. Assert file matches expected `- id:` entry format. |
| **project_context migration — entries appear in unified collection** | Seed 5 entries in `project_context`. Run `runMigration2to3('tenant-a')`. Assert `project_context` collection deleted. Assert 5 entries in `agent-ltm:tenant-a` with `scope: 'tenant:tenant-a'` and `tier: 'semantic'`. |
| **project_context — warm recall with minScore=0.45 filters noise** | Seed 10 entries migrated from `project_context`. Insert 5 with relevance scores < 0.45 to the test query. Call `MemoryWarmer.warmForTask()`. Assert only entries scoring ≥ 0.45 appear in the `<warm_memory>` block. |
| **Migration 1→2 — re-embed uses embedFn, not source vector** | Spy on `embedFn`. Run `runMigration1to2`. Assert `embedFn` called once per source point. Assert upserted vectors have length equal to `embedFn` output length. Assert no Qdrant `VectorDimensionError`. |
| **Migration 1→2 — dimension probed from embedFn, not hardcoded** | Mock `embedFn` to return a 768-dim vector. Run `runMigration1to2`. Assert new collection created with `vectors: { size: 768 }`. Assert NOT `size: 1536`. |
| **STM stage writes — architect output stored** | Call `runArchitect()` in executor with mock `memoryAdapter`. Assert `storeStageOutput` called with `stage: 'architect'` and `summary` containing plan excerpt. |
| **STM stage writes — orchestrate output stored** | Call `runOrchestrate()`. Assert `storeStageOutput` called with `stage: 'orchestrate'` and `detail.route` set to the exit route. |
| **STM intra-task recall — executor sees architect context** | Store architect stage output. Simulate executor calling `recallStageContext({ query: 'architecture decisions', taskId })`. Assert architect summary appears in results. |
