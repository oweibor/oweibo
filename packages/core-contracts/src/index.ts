/**
 * @oweibo/core-contracts
 *
 * The ONLY legal import source for all packages/module-* packages.
 * Zero runtime dependencies (except @oweibo/channel-contracts, also zero-dep).
 *
 * Import boundary enforced by dependency-cruiser:
 *   module-* → core-contracts ✓  (allowed)
 *   module-* → core-engine    ✗  (build error)
 *   module-* → module-*       ✗  (build error)
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export * from './types/ScaffoldInput.js';
export * from './types/ArtifactBundle.js';
export * from './types/ModuleKnowledge.js';
export * from './types/Plan.js';
export * from './types/AgentTypes.js';
export * from './types/CodebaseKnowledge.js';

// ── Interfaces ────────────────────────────────────────────────────────────────
export * from './interfaces/IModuleGenerator.js';
export * from './interfaces/IModuleManifest.js';
export * from './interfaces/IPlugin.js';
export * from './interfaces/IScopedEventBus.js';
export * from './interfaces/ISkill.js';
export * from './interfaces/IRemoteSkillSource.js';
export * from './interfaces/IPipelineTool.js';
export * from './interfaces/IPipelineStage.js';
export * from './interfaces/IMemorySystem.js';
export * from './interfaces/ILanguageAnalyzer.js';
export * from './interfaces/IDocTemplate.js';
export * from './interfaces/IVectorSearch.js';
export * from './interfaces/ITokenBudget.js';
export * from './interfaces/IGoalTemplateMatcher.js';
export * from './interfaces/IPlatformLessonRecall.js';

// ── Secrets ───────────────────────────────────────────────────────────────────
export * from './secrets/ISecretsManager.js';

// ── Browser (v9.5+) ───────────────────────────────────────────────────────────
export * from './browser.js';

// ── Phase A: prompt versioning + task types ───────────────────────────────────
export * from './task.js';
// ── Phase A.10: canonical role enum ──────────────────────────────────────────
export * from './roles.js';
// ── Phase B.1: cross-tenant lesson contract ───────────────────────────────────
export * from './lesson.js';

// ── T.−1: action trust ladder taxonomy + gate contract ───────────────────────
export * from './action/ActionClass.js';
export * from './action/IActionGate.js';

// ── S.0 (action-safety-v2): plan-level approval + lineage + blast radius ─────
export * from './action/BlastRadius.js';
export * from './action/ActionPlan.js';
export * from './action/ActionLineage.js';

// ── S.1 (action-safety-v2): approval SLAs + notification channels ────────────
export * from './action/ApprovalSla.js';

// ── S.2 (action-safety-v2): rate limiting ────────────────────────────────────
export * from './action/RateLimit.js';

// ── S.3 (action-safety-v2): rollback execution framework ─────────────────────
export * from './action/IRollbackAdapter.js';

// ── S.4 (action-safety-v2): multi-party + time-windowed approvals ────────────
export * from './action/ApprovalGrant.js';

// ── S.5 (action-safety-v2): pre-exec content inspection + post-exec verify ───
export * from './action/IContentInspector.js';
export * from './action/IPostExecutionVerifier.js';

// ── S.6 (action-safety-v2): action quotas + budget insurance ─────────────────
export * from './action/Quota.js';

// ── T.2.f: connector catalog + tenant-instance contracts ─────────────────────
export * from './connector/IConnector.js';

// ── T.2.h: org-graph nodes / edges / facts / stakeholder interests ───────────
export * from './org/OrgGraph.js';

// ── Events ────────────────────────────────────────────────────────────────────
export * from './events/billing.events.js';
export * from './events/inventory.events.js';
export * from './events/pos.events.js';
export * from './events/swarm.events.js';
// ── T.0: tenant lifecycle events ─────────────────────────────────────────────
export * from './events/tenant.events.js';
