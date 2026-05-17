"use strict";
// packages/core-engine/src/index.ts
// Core engine public API — exports all top-level classes needed by app entry point
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImmutableAuditLogger = exports.PipelineOrchestrator = exports.SessionStore = exports.OutputDeliveryService = exports.TaskInterventionGateway = exports.TaskEventBus = exports.IntentClarifier = exports.IntentPipeline = exports.S3StorageAdapter = exports.LocalStorageAdapter = exports.validateModuleDeletion = exports.OllamaVLMClient = exports.UnifiedObservationStream = exports.ToolPerformanceTracker = exports.ToolChainComposer = exports.ToolRegistry = exports.GitAdapter = exports.VirtualFileSystemValidator = exports.VerificationRunner = exports.EditApplicator = exports.EditPlanner = exports.GeneralRepoIndexer = exports.RepoMapBuilder = exports.AstMetadataCache = exports.CodeIntelligenceLayer = exports.ProjectRulesLoader = exports.RemoteSkillFetcher = exports.SkillRegistry = exports.ConversationalLoop = exports.GeneralCodingAgent = exports.GeneralCodingOrchestrator = exports.AgentTaskQueue = exports.TaskHeartbeat = exports.MultiStrategyPlanner = exports.WorkingMemoryRegistry = exports.WorkingMemory = exports.TieredShortTermMemoryStore = exports.QdrantSemanticStore = exports.ProjectRegistry = exports.MemoryOrchestrator = exports.KiloSemanticAdapter = exports.InstrumentedLLMClient = exports.GoalDecomposer = exports.DocumentationAgent = exports.DistributedContextStore = exports.ContextPruner = exports.ConflictResolver = exports.BaseAgent = exports.SwarmCoordinator = exports.CognitiveEngine = void 0;
exports.SecretsManager = exports.ModelRouter = exports.NullVaultClient = exports.PromptRegistry = exports.AnomalyDetector = exports.HITLGateway = exports.PolicyEngine = void 0;
// ── Agentic core ──────────────────────────────────────────────────────────────
var CognitiveEngine_js_1 = require("./agentic/CognitiveEngine.js");
Object.defineProperty(exports, "CognitiveEngine", { enumerable: true, get: function () { return CognitiveEngine_js_1.CognitiveEngine; } });
var SwarmCoordinator_js_1 = require("./agentic/SwarmCoordinator.js");
Object.defineProperty(exports, "SwarmCoordinator", { enumerable: true, get: function () { return SwarmCoordinator_js_1.SwarmCoordinator; } });
var BaseAgent_js_1 = require("./agentic/BaseAgent.js");
Object.defineProperty(exports, "BaseAgent", { enumerable: true, get: function () { return BaseAgent_js_1.BaseAgent; } });
var ConflictResolver_js_1 = require("./agentic/ConflictResolver.js");
Object.defineProperty(exports, "ConflictResolver", { enumerable: true, get: function () { return ConflictResolver_js_1.ConflictResolver; } });
var ContextPruner_js_1 = require("./agentic/ContextPruner.js");
Object.defineProperty(exports, "ContextPruner", { enumerable: true, get: function () { return ContextPruner_js_1.ContextPruner; } });
var DistributedContextStore_js_1 = require("./agentic/DistributedContextStore.js");
Object.defineProperty(exports, "DistributedContextStore", { enumerable: true, get: function () { return DistributedContextStore_js_1.DistributedContextStore; } });
var DocumentationAgent_js_1 = require("./agentic/DocumentationAgent.js");
Object.defineProperty(exports, "DocumentationAgent", { enumerable: true, get: function () { return DocumentationAgent_js_1.DocumentationAgent; } });
var GoalDecomposer_js_1 = require("./agentic/GoalDecomposer.js");
Object.defineProperty(exports, "GoalDecomposer", { enumerable: true, get: function () { return GoalDecomposer_js_1.GoalDecomposer; } });
var InstrumentedLLMClient_js_1 = require("./agentic/InstrumentedLLMClient.js");
Object.defineProperty(exports, "InstrumentedLLMClient", { enumerable: true, get: function () { return InstrumentedLLMClient_js_1.InstrumentedLLMClient; } });
// LongTermMemoryStore removed — replaced by QdrantSemanticStore (Phase 2)
var index_js_1 = require("./agentic/memory/index.js");
Object.defineProperty(exports, "KiloSemanticAdapter", { enumerable: true, get: function () { return index_js_1.KiloSemanticAdapter; } });
Object.defineProperty(exports, "MemoryOrchestrator", { enumerable: true, get: function () { return index_js_1.MemoryOrchestrator; } });
Object.defineProperty(exports, "ProjectRegistry", { enumerable: true, get: function () { return index_js_1.ProjectRegistry; } });
Object.defineProperty(exports, "QdrantSemanticStore", { enumerable: true, get: function () { return index_js_1.QdrantSemanticStore; } });
Object.defineProperty(exports, "TieredShortTermMemoryStore", { enumerable: true, get: function () { return index_js_1.ShortTermMemoryStore; } });
Object.defineProperty(exports, "WorkingMemory", { enumerable: true, get: function () { return index_js_1.WorkingMemory; } });
Object.defineProperty(exports, "WorkingMemoryRegistry", { enumerable: true, get: function () { return index_js_1.WorkingMemoryRegistry; } });
var MultiStrategyPlanner_js_1 = require("./agentic/MultiStrategyPlanner.js");
Object.defineProperty(exports, "MultiStrategyPlanner", { enumerable: true, get: function () { return MultiStrategyPlanner_js_1.MultiStrategyPlanner; } });
var TaskHeartbeat_js_1 = require("./agentic/TaskHeartbeat.js");
Object.defineProperty(exports, "TaskHeartbeat", { enumerable: true, get: function () { return TaskHeartbeat_js_1.TaskHeartbeat; } });
var TaskQueue_js_1 = require("./agentic/TaskQueue.js");
Object.defineProperty(exports, "AgentTaskQueue", { enumerable: true, get: function () { return TaskQueue_js_1.TaskQueue; } });
// ── General coding ────────────────────────────────────────────────────────────
var GeneralCodingOrchestrator_js_1 = require("./general-coding/GeneralCodingOrchestrator.js");
Object.defineProperty(exports, "GeneralCodingOrchestrator", { enumerable: true, get: function () { return GeneralCodingOrchestrator_js_1.GeneralCodingOrchestrator; } });
var GeneralCodingAgent_js_1 = require("./general-coding/GeneralCodingAgent.js");
Object.defineProperty(exports, "GeneralCodingAgent", { enumerable: true, get: function () { return GeneralCodingAgent_js_1.GeneralCodingAgent; } });
var ConversationalLoop_js_1 = require("./general-coding/ConversationalLoop.js");
Object.defineProperty(exports, "ConversationalLoop", { enumerable: true, get: function () { return ConversationalLoop_js_1.ConversationalLoop; } });
var SkillRegistry_js_1 = require("./general-coding/project/SkillRegistry.js");
Object.defineProperty(exports, "SkillRegistry", { enumerable: true, get: function () { return SkillRegistry_js_1.SkillRegistry; } });
var RemoteSkillFetcher_js_1 = require("./general-coding/project/RemoteSkillFetcher.js");
Object.defineProperty(exports, "RemoteSkillFetcher", { enumerable: true, get: function () { return RemoteSkillFetcher_js_1.RemoteSkillFetcher; } });
var ProjectRulesLoader_js_1 = require("./general-coding/project/ProjectRulesLoader.js");
Object.defineProperty(exports, "ProjectRulesLoader", { enumerable: true, get: function () { return ProjectRulesLoader_js_1.ProjectRulesLoader; } });
var CodeIntelligenceLayer_js_1 = require("./general-coding/intelligence/CodeIntelligenceLayer.js");
Object.defineProperty(exports, "CodeIntelligenceLayer", { enumerable: true, get: function () { return CodeIntelligenceLayer_js_1.CodeIntelligenceLayer; } });
var AstMetadataCache_js_1 = require("./general-coding/intelligence/AstMetadataCache.js");
Object.defineProperty(exports, "AstMetadataCache", { enumerable: true, get: function () { return AstMetadataCache_js_1.AstMetadataCache; } });
var RepoMapBuilder_js_1 = require("./general-coding/intelligence/RepoMapBuilder.js");
Object.defineProperty(exports, "RepoMapBuilder", { enumerable: true, get: function () { return RepoMapBuilder_js_1.RepoMapBuilder; } });
var GeneralRepoIndexer_js_1 = require("./general-coding/intelligence/GeneralRepoIndexer.js");
Object.defineProperty(exports, "GeneralRepoIndexer", { enumerable: true, get: function () { return GeneralRepoIndexer_js_1.GeneralRepoIndexer; } });
var EditPlanner_js_1 = require("./general-coding/editing/EditPlanner.js");
Object.defineProperty(exports, "EditPlanner", { enumerable: true, get: function () { return EditPlanner_js_1.EditPlanner; } });
var EditApplicator_js_1 = require("./general-coding/editing/EditApplicator.js");
Object.defineProperty(exports, "EditApplicator", { enumerable: true, get: function () { return EditApplicator_js_1.EditApplicator; } });
var VerificationRunner_js_1 = require("./general-coding/editing/VerificationRunner.js");
Object.defineProperty(exports, "VerificationRunner", { enumerable: true, get: function () { return VerificationRunner_js_1.VerificationRunner; } });
var VirtualFileSystemValidator_js_1 = require("./general-coding/editing/VirtualFileSystemValidator.js");
Object.defineProperty(exports, "VirtualFileSystemValidator", { enumerable: true, get: function () { return VirtualFileSystemValidator_js_1.VirtualFileSystemValidator; } });
var GitAdapter_js_1 = require("./general-coding/git/GitAdapter.js");
Object.defineProperty(exports, "GitAdapter", { enumerable: true, get: function () { return GitAdapter_js_1.GitAdapter; } });
// ── Tools ─────────────────────────────────────────────────────────────────────
var ToolRegistry_js_1 = require("./tools/ToolRegistry.js");
Object.defineProperty(exports, "ToolRegistry", { enumerable: true, get: function () { return ToolRegistry_js_1.ToolRegistry; } });
var ToolChainComposer_js_1 = require("./tools/ToolChainComposer.js");
Object.defineProperty(exports, "ToolChainComposer", { enumerable: true, get: function () { return ToolChainComposer_js_1.ToolChainComposer; } });
var ToolPerformanceTracker_js_1 = require("./tools/ToolPerformanceTracker.js");
Object.defineProperty(exports, "ToolPerformanceTracker", { enumerable: true, get: function () { return ToolPerformanceTracker_js_1.ToolPerformanceTracker; } });
// ── Agentic extras ────────────────────────────────────────────────────────────
var UnifiedObservationStream_js_1 = require("./agentic/UnifiedObservationStream.js");
Object.defineProperty(exports, "UnifiedObservationStream", { enumerable: true, get: function () { return UnifiedObservationStream_js_1.UnifiedObservationStream; } });
var VLMClient_js_1 = require("./agentic/VLMClient.js");
Object.defineProperty(exports, "OllamaVLMClient", { enumerable: true, get: function () { return VLMClient_js_1.OllamaVLMClient; } });
// ── Registry extras ───────────────────────────────────────────────────────────
var DeletionGuard_js_1 = require("./registry/DeletionGuard.js");
Object.defineProperty(exports, "validateModuleDeletion", { enumerable: true, get: function () { return DeletionGuard_js_1.validateModuleDeletion; } });
// ── Storage adapters ──────────────────────────────────────────────────────────
var StorageAdapter_js_1 = require("./infra/adapters/StorageAdapter.js");
Object.defineProperty(exports, "LocalStorageAdapter", { enumerable: true, get: function () { return StorageAdapter_js_1.LocalStorageAdapter; } });
Object.defineProperty(exports, "S3StorageAdapter", { enumerable: true, get: function () { return StorageAdapter_js_1.S3StorageAdapter; } });
// ── Ingestion ─────────────────────────────────────────────────────────────────
var IntentPipeline_js_1 = require("./ingestion/IntentPipeline.js");
Object.defineProperty(exports, "IntentPipeline", { enumerable: true, get: function () { return IntentPipeline_js_1.IntentPipeline; } });
var IntentClarifier_js_1 = require("./ingestion/IntentClarifier.js");
Object.defineProperty(exports, "IntentClarifier", { enumerable: true, get: function () { return IntentClarifier_js_1.IntentClarifier; } });
var TaskEventBus_js_1 = require("./ingestion/TaskEventBus.js");
Object.defineProperty(exports, "TaskEventBus", { enumerable: true, get: function () { return TaskEventBus_js_1.TaskEventBus; } });
var TaskInterventionGateway_js_1 = require("./ingestion/TaskInterventionGateway.js");
Object.defineProperty(exports, "TaskInterventionGateway", { enumerable: true, get: function () { return TaskInterventionGateway_js_1.TaskInterventionGateway; } });
var OutputDeliveryService_js_1 = require("./ingestion/OutputDeliveryService.js");
Object.defineProperty(exports, "OutputDeliveryService", { enumerable: true, get: function () { return OutputDeliveryService_js_1.OutputDeliveryService; } });
var SessionStore_js_1 = require("./ingestion/SessionStore.js");
Object.defineProperty(exports, "SessionStore", { enumerable: true, get: function () { return SessionStore_js_1.SessionStore; } });
// ── Pipeline ──────────────────────────────────────────────────────────────────
var PipelineOrchestrator_js_1 = require("./pipeline/PipelineOrchestrator.js");
Object.defineProperty(exports, "PipelineOrchestrator", { enumerable: true, get: function () { return PipelineOrchestrator_js_1.PipelineOrchestrator; } });
// ── Governance ────────────────────────────────────────────────────────────────
var ImmutableAuditLogger_js_1 = require("./governance/ImmutableAuditLogger.js");
Object.defineProperty(exports, "ImmutableAuditLogger", { enumerable: true, get: function () { return ImmutableAuditLogger_js_1.ImmutableAuditLogger; } });
var PolicyEngine_js_1 = require("./governance/PolicyEngine.js");
Object.defineProperty(exports, "PolicyEngine", { enumerable: true, get: function () { return PolicyEngine_js_1.PolicyEngine; } });
var HITLGateway_js_1 = require("./governance/HITLGateway.js");
Object.defineProperty(exports, "HITLGateway", { enumerable: true, get: function () { return HITLGateway_js_1.HITLGateway; } });
// ── Observability ─────────────────────────────────────────────────────────────
var AnomalyDetector_js_1 = require("./observability/AnomalyDetector.js");
Object.defineProperty(exports, "AnomalyDetector", { enumerable: true, get: function () { return AnomalyDetector_js_1.AnomalyDetector; } });
var PromptRegistry_js_1 = require("./observability/PromptRegistry.js");
Object.defineProperty(exports, "PromptRegistry", { enumerable: true, get: function () { return PromptRegistry_js_1.PromptRegistry; } });
var VaultClient_js_1 = require("./infrastructure/VaultClient.js");
Object.defineProperty(exports, "NullVaultClient", { enumerable: true, get: function () { return VaultClient_js_1.NullVaultClient; } });
var ModelRouter_js_1 = require("./infrastructure/ModelRouter.js");
Object.defineProperty(exports, "ModelRouter", { enumerable: true, get: function () { return ModelRouter_js_1.ModelRouter; } });
// ── Secrets ───────────────────────────────────────────────────────────────────
var SecretsManager_js_1 = require("./secrets/SecretsManager.js");
Object.defineProperty(exports, "SecretsManager", { enumerable: true, get: function () { return SecretsManager_js_1.SecretsManager; } });
//# sourceMappingURL=index.js.map