The remaining 25 errors are:

* **`general-coding/` files** (11) — `EditPlanner`, `FileClassifier`, `SpecialistAgentFactory`, `SynthesisAgent`, `registerGeneralCodingTools` — missing types in `core-contracts` (`FileClassifierRule`, `TenantSpawnBudget`), missing `minimatch` package, `'synthesizer'` not in `AgentRole`, `ContextRecord | null` cast
* **`sandbox/`** (14) — `PoolAutoscaler`, `TieredWarmPoolManager` — pre-existing `noUncheckedIndexedAccess` and `PoolEntry` shape issues

The following analysis details the session management architecture of the `oweibo` codebase, focusing on its ability to preserve state and context during long-running asynchronous workflows and Human-in-the-Loop (HITL) interruptions.
