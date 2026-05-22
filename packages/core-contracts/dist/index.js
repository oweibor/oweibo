"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
// ── Types ─────────────────────────────────────────────────────────────────────
__exportStar(require("./types/ScaffoldInput.js"), exports);
__exportStar(require("./types/ArtifactBundle.js"), exports);
__exportStar(require("./types/ModuleKnowledge.js"), exports);
__exportStar(require("./types/Plan.js"), exports);
__exportStar(require("./types/AgentTypes.js"), exports);
__exportStar(require("./types/CodebaseKnowledge.js"), exports);
// ── Interfaces ────────────────────────────────────────────────────────────────
__exportStar(require("./interfaces/IModuleGenerator.js"), exports);
__exportStar(require("./interfaces/IModuleManifest.js"), exports);
__exportStar(require("./interfaces/IPlugin.js"), exports);
__exportStar(require("./interfaces/IScopedEventBus.js"), exports);
__exportStar(require("./interfaces/ISkill.js"), exports);
__exportStar(require("./interfaces/IRemoteSkillSource.js"), exports);
__exportStar(require("./interfaces/IPipelineTool.js"), exports);
__exportStar(require("./interfaces/IPipelineStage.js"), exports);
__exportStar(require("./interfaces/IMemorySystem.js"), exports);
__exportStar(require("./interfaces/ILanguageAnalyzer.js"), exports);
__exportStar(require("./interfaces/IDocTemplate.js"), exports);
__exportStar(require("./interfaces/IVectorSearch.js"), exports);
__exportStar(require("./interfaces/ITokenBudget.js"), exports);
// ── Secrets ───────────────────────────────────────────────────────────────────
__exportStar(require("./secrets/ISecretsManager.js"), exports);
// ── Browser (v9.5+) ───────────────────────────────────────────────────────────
__exportStar(require("./browser.js"), exports);
// ── Phase A: prompt versioning + task types ───────────────────────────────────
__exportStar(require("./task.js"), exports);
// ── Phase A.10: canonical role enum ──────────────────────────────────────────
__exportStar(require("./roles.js"), exports);
// ── Phase B.1: cross-tenant lesson contract ───────────────────────────────────
__exportStar(require("./lesson.js"), exports);
// ── T.−1: action trust ladder taxonomy + gate contract ───────────────────────
__exportStar(require("./action/ActionClass.js"), exports);
__exportStar(require("./action/IActionGate.js"), exports);
// ── Events ────────────────────────────────────────────────────────────────────
__exportStar(require("./events/billing.events.js"), exports);
__exportStar(require("./events/inventory.events.js"), exports);
__exportStar(require("./events/pos.events.js"), exports);
__exportStar(require("./events/swarm.events.js"), exports);
//# sourceMappingURL=index.js.map