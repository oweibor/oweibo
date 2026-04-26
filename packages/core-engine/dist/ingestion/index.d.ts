/**
 * ingestion/index.ts — public API consumed by channel-gateway.
 *
 * Dependency-cruiser rule: channel-gateway may only import these three interfaces.
 * Any other import from core-engine by channel-gateway is a build error.
 */
export { IntentPipeline } from './IntentPipeline.js';
export type { SubmitResult } from './IntentPipeline.js';
export { TaskEventBus } from './TaskEventBus.js';
export type { TaskEvent, TaskEventHandler } from './TaskEventBus.js';
export { TaskInterventionGateway } from './TaskInterventionGateway.js';
export type { TaskIntervention, InterventionType } from './TaskInterventionGateway.js';
export type { RawIntent, ClassifiedIntent } from './IntentClarifier.js';
export { IntentClarifier } from './IntentClarifier.js';
export { SessionStore } from './SessionStore.js';
export type { SessionData, SessionTaskSummary } from './SessionStore.js';
export { OutputDeliveryService } from './OutputDeliveryService.js';
export type { DeliveryPayload, DeliveryReceipt } from './OutputDeliveryService.js';
//# sourceMappingURL=index.d.ts.map