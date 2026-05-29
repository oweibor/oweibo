// packages/core-engine/src/index.ts
// Core engine public API — exports all top-level classes needed by app entry point

// ── Agentic core ──────────────────────────────────────────────────────────────
export { CognitiveEngine } from './agentic/CognitiveEngine.js';
export { SwarmCoordinator } from './agentic/SwarmCoordinator.js';
export { BaseAgent } from './agentic/BaseAgent.js';
export { ConflictResolver } from './agentic/ConflictResolver.js';
export { ContextPruner } from './agentic/ContextPruner.js';
export { DistributedContextStore } from './agentic/DistributedContextStore.js';
export { DocumentationAgent } from './agentic/DocumentationAgent.js';
export { GoalDecomposer } from './agentic/GoalDecomposer.js';
export { InstrumentedLLMClient } from './agentic/InstrumentedLLMClient.js';
// LongTermMemoryStore removed — replaced by QdrantSemanticStore (Phase 2)
export {
  KiloSemanticAdapter,
  MemoryOrchestrator,
  ProjectRegistry,
  QdrantSemanticStore,
  ShortTermMemoryStore as TieredShortTermMemoryStore,
  WorkingMemory,
  WorkingMemoryRegistry,
} from './agentic/memory/index.js';
export type {
  Embedder,
  KiloSemanticAdapterDeps,
  MemoryOrchestratorDeps,
  QdrantSemanticStoreDeps,
  QdrantSemanticStoreConfig,
} from './agentic/memory/index.js';
export { MultiStrategyPlanner } from './agentic/MultiStrategyPlanner.js';
export { TaskHeartbeat } from './agentic/TaskHeartbeat.js';
export { TaskQueue as AgentTaskQueue } from './agentic/TaskQueue.js';

// ── General coding ────────────────────────────────────────────────────────────
export { GeneralCodingOrchestrator } from './general-coding/GeneralCodingOrchestrator.js';
export { GeneralCodingAgent } from './general-coding/GeneralCodingAgent.js';
export { ConversationalLoop } from './general-coding/ConversationalLoop.js';
export { SkillRegistry } from './general-coding/project/SkillRegistry.js';
export { RemoteSkillFetcher } from './general-coding/project/RemoteSkillFetcher.js';
export { ProjectRulesLoader } from './general-coding/project/ProjectRulesLoader.js';
export { CodeIntelligenceLayer } from './general-coding/intelligence/CodeIntelligenceLayer.js';
export { AstMetadataCache } from './general-coding/intelligence/AstMetadataCache.js';
export { RepoMapBuilder } from './general-coding/intelligence/RepoMapBuilder.js';
export { GeneralRepoIndexer } from './general-coding/intelligence/GeneralRepoIndexer.js';
export { EditPlanner } from './general-coding/editing/EditPlanner.js';
export { EditApplicator } from './general-coding/editing/EditApplicator.js';
export { VerificationRunner } from './general-coding/editing/VerificationRunner.js';
export { VirtualFileSystemValidator } from './general-coding/editing/VirtualFileSystemValidator.js';
export { GitAdapter } from './general-coding/git/GitAdapter.js';

// ── Tools ─────────────────────────────────────────────────────────────────────
export { ToolRegistry } from './tools/ToolRegistry.js';
export { ToolChainComposer } from './tools/ToolChainComposer.js';
export { ToolPerformanceTracker } from './tools/ToolPerformanceTracker.js';
export type { ToolChainStep, ToolChainResult } from './tools/ToolChainComposer.js';

// ── Agentic extras ────────────────────────────────────────────────────────────
export { UnifiedObservationStream } from './agentic/UnifiedObservationStream.js';
export type { Observation, ObservationSource } from './agentic/UnifiedObservationStream.js';
export { OllamaVLMClient } from './agentic/VLMClient.js';
export type { VLMAnalysis, ContextualVisualReasoning } from './agentic/VLMClient.js';

// ── Registry extras ───────────────────────────────────────────────────────────
export { validateModuleDeletion } from './registry/DeletionGuard.js';
export type { DeletionValidationResult, IDeletionHostContext } from './registry/DeletionGuard.js';

// ── Storage adapters ──────────────────────────────────────────────────────────
export { LocalStorageAdapter, S3StorageAdapter } from './infra/adapters/StorageAdapter.js';
export type { StorageAdapter } from './infra/adapters/StorageAdapter.js';

// ── Ingestion ─────────────────────────────────────────────────────────────────
export { IntentPipeline } from './ingestion/IntentPipeline.js';
export { IntentClarifier } from './ingestion/IntentClarifier.js';
export { TaskEventBus } from './ingestion/TaskEventBus.js';
export { TaskInterventionGateway } from './ingestion/TaskInterventionGateway.js';
export { OutputDeliveryService } from './ingestion/OutputDeliveryService.js';
export { SessionStore } from './ingestion/SessionStore.js';

// ── Pipeline ──────────────────────────────────────────────────────────────────
export { PipelineOrchestrator } from './pipeline/PipelineOrchestrator.js';

// ── Governance ────────────────────────────────────────────────────────────────
export { ImmutableAuditLogger } from './governance/ImmutableAuditLogger.js';
export { PolicyEngine } from './governance/PolicyEngine.js';
export { HITLGateway } from './governance/HITLGateway.js';

// ── Observability ─────────────────────────────────────────────────────────────
export { AnomalyDetector } from './observability/AnomalyDetector.js';
export { PromptRegistry } from './observability/PromptRegistry.js';

// ── Infrastructure ────────────────────────────────────────────────────────────
export type { VaultClient } from './infrastructure/VaultClient.js';
export { NullVaultClient } from './infrastructure/VaultClient.js';
export { ModelRouter } from './infrastructure/ModelRouter.js';

// ── Secrets ───────────────────────────────────────────────────────────────────
export { SecretsManager } from './secrets/SecretsManager.js';

// ── Action safety (S.1–S.7 + F.1) ─────────────────────────────────────────────
export { ApprovalSlaService } from './action/ApprovalSlaService.js';
export { EscalationEngine } from './action/EscalationEngine.js';
export type { IOrgGraphReader, ITenantRoleReader, IEscalationLogger } from './action/EscalationEngine.js';
export { NotificationRouter } from './action/NotificationRouter.js';
export { PgOrgGraphReader } from './action/PgOrgGraphReader.js';
export { PgTenantRoleReader } from './action/PgTenantRoleReader.js';
export {
  RedisTaskEventBusPublisher,
  TASK_EVENT_BUS_CHANNEL,
  TASK_APPROVAL_DECIDED_V1_SUBJECT,
} from './action/RedisTaskEventBusPublisher.js';
export type { RedisPublishFn, ITaskEventBusPublisher } from './action/RedisTaskEventBusPublisher.js';
export { PostExecutionVerifierService, InMemoryVerifierRegistry } from './action/PostExecutionVerifierService.js';
export type { VerifierRegistry } from './action/PostExecutionVerifierService.js';

// ── Notification channels ─────────────────────────────────────────────────────
export { InAppChannel } from './action/notification-channels/InAppChannel.js';
export { EmailChannel } from './action/notification-channels/EmailChannel.js';
export { SlackChannel } from './action/notification-channels/SlackChannel.js';
export { WebhookChannel } from './action/notification-channels/WebhookChannel.js';

// ── Webhook + binding resolvers (F.1.6, F.1.8) ────────────────────────────────
export { PgWebhookConfigResolver } from './action/PgWebhookConfigResolver.js';
export type { IWebhookConfigResolver, ResolvedWebhookConfig, WebhookKind } from './action/PgWebhookConfigResolver.js';
export { PgTenantDomainBindingLookup } from './domain/PgTenantDomainBindingLookup.js';

// ── Type re-exports ───────────────────────────────────────────────────────────
export type { GeneralCodingResult } from './general-coding/GeneralCodingOrchestrator.js';
export type { EditPlan } from './general-coding/ConversationalLoop.js';
export type { EditProposal } from './general-coding/GeneralCodingAgent.js';
export type { SwarmResult } from './agentic/SwarmCoordinator.js';
export type { PipelineOrchestratorDeps } from './pipeline/PipelineOrchestrator.js';
export type { IntegrityReport } from './general-coding/project/RemoteSkillFetcher.js';
