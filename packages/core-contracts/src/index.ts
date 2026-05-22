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

// ── Events ────────────────────────────────────────────────────────────────────
export * from './events/billing.events.js';
export * from './events/inventory.events.js';
export * from './events/pos.events.js';
export * from './events/swarm.events.js';
