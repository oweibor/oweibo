// packages/browser-tool/src/index.ts
// Public API for @oweibo/browser-tool

// ── Contracts ─────────────────────────────────────────────────────────────────
export { BrowserActionSchema } from './tool/BrowserActionSchema.js';
export type { BrowserActionInput } from './tool/BrowserActionSchema.js';
export type { IBrowserBackend, BrowserBackendType } from './contracts/IBrowserBackend.js';
export * from './contracts/errors.js';

// ── Tool ──────────────────────────────────────────────────────────────────────
export { BrowserTool }         from './tool/BrowserTool.js';
export { BrowserPromptBudget } from './tool/BrowserPromptBudget.js';

// ── Backends + Routing ────────────────────────────────────────────────────────
export { BrowserBackendRouter }   from './stealth/BrowserBackendRouter.js';
export { UserAgentRotator }       from './stealth/UserAgentRotator.js';
export type { UAEntry }           from './stealth/UserAgentRotator.js';
export { StealthProfilePool }     from './stealth/StealthProfilePool.js';
export { LocalPlaywrightBackend } from './stealth/backends/LocalPlaywrightBackend.js';
export { BrowserbaseBackend }     from './stealth/backends/BrowserbaseBackend.js';
export { BrightDataBackend }      from './stealth/backends/BrightDataBackend.js';
export { UserChromeBackend }      from './stealth/backends/UserChromeBackend.js';
export { PersistentProfileBackend } from './stealth/backends/PersistentProfileBackend.js';
export { ChromeExtensionBackend } from './stealth/backends/ChromeExtensionBackend.js';

// ── Session ───────────────────────────────────────────────────────────────────
export { BrowserSessionManager }  from './session/BrowserSessionManager.js';
export { ExtensionBridgeServer }  from './session/ExtensionBridgeServer.js';

// ── Vision + Streaming ────────────────────────────────────────────────────────
export { BrowserVisionBridge }    from './vision/BrowserVisionBridge.js';
export { BrowserVisionLoop }      from './vision/BrowserVisionLoop.js';   // @deprecated alias
export { VisionPromptBuilder }    from './vision/VisionPromptBuilder.js';
export type { VisionLoopTurn, VisionPromptInput } from './vision/VisionPromptBuilder.js';
export { ActionSelector }         from './vision/ActionSelector.js';
export type { ActionSelection, ActionSelectionResult, ActionSelectionFailure } from './vision/ActionSelector.js';
export { BrowserEventStreamer }   from './streaming/BrowserEventStreamer.js';

// ── Policy ────────────────────────────────────────────────────────────────────
export { SafeBrowsingClient }     from './policy/SafeBrowsingClient.js';
export { VideoReaper, HarReaper, PdfReaper, ClamAvFreshnessJob } from './policy/reapers.js';

// ── Skill / CLI / MCP ─────────────────────────────────────────────────────────
export { BrowserSkillActionParser } from './skill/BrowserSkillActionParser.js';
export { BrowserCLICommands }       from './cli/BrowserCLICommands.js';
export { BrowserMcpServer }         from './mcp/BrowserMcpServer.js';
