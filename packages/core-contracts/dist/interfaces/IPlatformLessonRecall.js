"use strict";
/**
 * T.4: IPlatformLessonRecall — the consumer-side counterpart to the
 * pattern-bank contributor path.
 *
 * Implementations read pre-anonymised lessons from oweibo.platform_lessons
 * (gated by the K-anonymity ≥ 5 view oweibo.releasable_buckets) and return
 * hits that match the agent's query. The contract intentionally does not
 * take a tenantId — these lessons are platform-wide and cross-tenant by
 * construction. Callers must not re-attribute them.
 *
 * A per-tenant feature flag in the runtime decides whether
 * MemoryWarmer adds a platform-lesson recall channel; the contract is
 * stable regardless of how the flag is wired.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=IPlatformLessonRecall.js.map