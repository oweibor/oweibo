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
export * from './types/ScaffoldInput.js';
export * from './types/ArtifactBundle.js';
export * from './types/ModuleKnowledge.js';
export * from './types/Plan.js';
export * from './types/AgentTypes.js';
export * from './types/CodebaseKnowledge.js';
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
export * from './secrets/ISecretsManager.js';
export * from './browser.js';
export * from './task.js';
export * from './roles.js';
export * from './lesson.js';
export * from './action/ActionClass.js';
export * from './action/IActionGate.js';
export * from './events/billing.events.js';
export * from './events/inventory.events.js';
export * from './events/pos.events.js';
export * from './events/swarm.events.js';
//# sourceMappingURL=index.d.ts.map