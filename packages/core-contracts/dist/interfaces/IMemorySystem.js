"use strict";
/**
 * IMemorySystem — contracts for the four-tier context-aware memory subsystem.
 *
 * Design goals:
 *   1. Hard tenant isolation. `tenantId` is a mandatory parameter on every
 *      operation. A missing tenantId MUST be a TypeScript compile error, not
 *      a runtime filter that might be forgotten. There is no "global" fallback.
 *   2. Four discrete tiers, each with a clear lifetime and ownership:
 *        Working        — per-turn, in-process; evaporates at turn end
 *        Short-term     — per-session (conversation), TTL'd; Redis
 *        Project        — tenant+project scoped, durable
 *        Semantic       — tenant-scoped vector store, durable
 *   3. Typed memory kinds so the consolidator can extract structured knowledge
 *      from task outcomes, not just embed a single strategy string.
 *   4. Context-aware retrieval: the `assembleContext()` facade returns a
 *      ranked, de-duplicated, budget-aware bundle from all tiers, not a raw
 *      vector dump from one tier.
 *
 * This file is the ONLY place the outside world imports memory types from.
 * Implementations live in @oweibo/core-engine under agentic/memory/.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=IMemorySystem.js.map