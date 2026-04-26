"use strict";
// packages/browser-tool/src/index.ts
// Public API for @oweibo/browser-tool
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
exports.BrowserMcpServer = exports.BrowserCLICommands = exports.BrowserSkillActionParser = exports.ClamAvFreshnessJob = exports.PdfReaper = exports.HarReaper = exports.VideoReaper = exports.SafeBrowsingClient = exports.BrowserEventStreamer = exports.ActionSelector = exports.VisionPromptBuilder = exports.BrowserVisionLoop = exports.BrowserVisionBridge = exports.ExtensionBridgeServer = exports.BrowserSessionManager = exports.ChromeExtensionBackend = exports.PersistentProfileBackend = exports.UserChromeBackend = exports.BrightDataBackend = exports.BrowserbaseBackend = exports.LocalPlaywrightBackend = exports.StealthProfilePool = exports.UserAgentRotator = exports.BrowserBackendRouter = exports.BrowserPromptBudget = exports.BrowserTool = exports.BrowserActionSchema = void 0;
// ── Contracts ─────────────────────────────────────────────────────────────────
var BrowserActionSchema_js_1 = require("./tool/BrowserActionSchema.js");
Object.defineProperty(exports, "BrowserActionSchema", { enumerable: true, get: function () { return BrowserActionSchema_js_1.BrowserActionSchema; } });
__exportStar(require("./contracts/errors.js"), exports);
// ── Tool ──────────────────────────────────────────────────────────────────────
var BrowserTool_js_1 = require("./tool/BrowserTool.js");
Object.defineProperty(exports, "BrowserTool", { enumerable: true, get: function () { return BrowserTool_js_1.BrowserTool; } });
var BrowserPromptBudget_js_1 = require("./tool/BrowserPromptBudget.js");
Object.defineProperty(exports, "BrowserPromptBudget", { enumerable: true, get: function () { return BrowserPromptBudget_js_1.BrowserPromptBudget; } });
// ── Backends + Routing ────────────────────────────────────────────────────────
var BrowserBackendRouter_js_1 = require("./stealth/BrowserBackendRouter.js");
Object.defineProperty(exports, "BrowserBackendRouter", { enumerable: true, get: function () { return BrowserBackendRouter_js_1.BrowserBackendRouter; } });
var UserAgentRotator_js_1 = require("./stealth/UserAgentRotator.js");
Object.defineProperty(exports, "UserAgentRotator", { enumerable: true, get: function () { return UserAgentRotator_js_1.UserAgentRotator; } });
var StealthProfilePool_js_1 = require("./stealth/StealthProfilePool.js");
Object.defineProperty(exports, "StealthProfilePool", { enumerable: true, get: function () { return StealthProfilePool_js_1.StealthProfilePool; } });
var LocalPlaywrightBackend_js_1 = require("./stealth/backends/LocalPlaywrightBackend.js");
Object.defineProperty(exports, "LocalPlaywrightBackend", { enumerable: true, get: function () { return LocalPlaywrightBackend_js_1.LocalPlaywrightBackend; } });
var BrowserbaseBackend_js_1 = require("./stealth/backends/BrowserbaseBackend.js");
Object.defineProperty(exports, "BrowserbaseBackend", { enumerable: true, get: function () { return BrowserbaseBackend_js_1.BrowserbaseBackend; } });
var BrightDataBackend_js_1 = require("./stealth/backends/BrightDataBackend.js");
Object.defineProperty(exports, "BrightDataBackend", { enumerable: true, get: function () { return BrightDataBackend_js_1.BrightDataBackend; } });
var UserChromeBackend_js_1 = require("./stealth/backends/UserChromeBackend.js");
Object.defineProperty(exports, "UserChromeBackend", { enumerable: true, get: function () { return UserChromeBackend_js_1.UserChromeBackend; } });
var PersistentProfileBackend_js_1 = require("./stealth/backends/PersistentProfileBackend.js");
Object.defineProperty(exports, "PersistentProfileBackend", { enumerable: true, get: function () { return PersistentProfileBackend_js_1.PersistentProfileBackend; } });
var ChromeExtensionBackend_js_1 = require("./stealth/backends/ChromeExtensionBackend.js");
Object.defineProperty(exports, "ChromeExtensionBackend", { enumerable: true, get: function () { return ChromeExtensionBackend_js_1.ChromeExtensionBackend; } });
// ── Session ───────────────────────────────────────────────────────────────────
var BrowserSessionManager_js_1 = require("./session/BrowserSessionManager.js");
Object.defineProperty(exports, "BrowserSessionManager", { enumerable: true, get: function () { return BrowserSessionManager_js_1.BrowserSessionManager; } });
var ExtensionBridgeServer_js_1 = require("./session/ExtensionBridgeServer.js");
Object.defineProperty(exports, "ExtensionBridgeServer", { enumerable: true, get: function () { return ExtensionBridgeServer_js_1.ExtensionBridgeServer; } });
// ── Vision + Streaming ────────────────────────────────────────────────────────
var BrowserVisionBridge_js_1 = require("./vision/BrowserVisionBridge.js");
Object.defineProperty(exports, "BrowserVisionBridge", { enumerable: true, get: function () { return BrowserVisionBridge_js_1.BrowserVisionBridge; } });
var BrowserVisionLoop_js_1 = require("./vision/BrowserVisionLoop.js"); // @deprecated alias
Object.defineProperty(exports, "BrowserVisionLoop", { enumerable: true, get: function () { return BrowserVisionLoop_js_1.BrowserVisionLoop; } });
var VisionPromptBuilder_js_1 = require("./vision/VisionPromptBuilder.js");
Object.defineProperty(exports, "VisionPromptBuilder", { enumerable: true, get: function () { return VisionPromptBuilder_js_1.VisionPromptBuilder; } });
var ActionSelector_js_1 = require("./vision/ActionSelector.js");
Object.defineProperty(exports, "ActionSelector", { enumerable: true, get: function () { return ActionSelector_js_1.ActionSelector; } });
var BrowserEventStreamer_js_1 = require("./streaming/BrowserEventStreamer.js");
Object.defineProperty(exports, "BrowserEventStreamer", { enumerable: true, get: function () { return BrowserEventStreamer_js_1.BrowserEventStreamer; } });
// ── Policy ────────────────────────────────────────────────────────────────────
var SafeBrowsingClient_js_1 = require("./policy/SafeBrowsingClient.js");
Object.defineProperty(exports, "SafeBrowsingClient", { enumerable: true, get: function () { return SafeBrowsingClient_js_1.SafeBrowsingClient; } });
var reapers_js_1 = require("./policy/reapers.js");
Object.defineProperty(exports, "VideoReaper", { enumerable: true, get: function () { return reapers_js_1.VideoReaper; } });
Object.defineProperty(exports, "HarReaper", { enumerable: true, get: function () { return reapers_js_1.HarReaper; } });
Object.defineProperty(exports, "PdfReaper", { enumerable: true, get: function () { return reapers_js_1.PdfReaper; } });
Object.defineProperty(exports, "ClamAvFreshnessJob", { enumerable: true, get: function () { return reapers_js_1.ClamAvFreshnessJob; } });
// ── Skill / CLI / MCP ─────────────────────────────────────────────────────────
var BrowserSkillActionParser_js_1 = require("./skill/BrowserSkillActionParser.js");
Object.defineProperty(exports, "BrowserSkillActionParser", { enumerable: true, get: function () { return BrowserSkillActionParser_js_1.BrowserSkillActionParser; } });
var BrowserCLICommands_js_1 = require("./cli/BrowserCLICommands.js");
Object.defineProperty(exports, "BrowserCLICommands", { enumerable: true, get: function () { return BrowserCLICommands_js_1.BrowserCLICommands; } });
var BrowserMcpServer_js_1 = require("./mcp/BrowserMcpServer.js");
Object.defineProperty(exports, "BrowserMcpServer", { enumerable: true, get: function () { return BrowserMcpServer_js_1.BrowserMcpServer; } });
//# sourceMappingURL=index.js.map