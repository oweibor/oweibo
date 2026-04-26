/**
 * OutputDeliveryService — delivers task outputs to the configured destination (v5, §16d).
 *
 * Supports four delivery modes (DeliveryMode from core-contracts):
 *   'download-link'  — upload artifact to object storage, return a signed URL
 *   'git-push'       — push generated code to a remote git branch
 *   'webhook'        — POST the result JSON to the caller's webhook URL
 *   'channel-reply'  — send the result back via the originating chat channel (v9.3)
 *
 * All modes emit a 'output-ready' TaskEventBus event with the delivery location.
 */
import type { DeliveryConfig, DeliveryMode } from '@oweibo/core-contracts';
import type { TaskEventBus } from './TaskEventBus.js';
export interface DeliveryPayload {
    readonly taskId: string;
    readonly sessionId: string;
    readonly tenantId: string;
    readonly artifactPath?: string;
    readonly artifactContent?: unknown;
    readonly summary: string;
}
export interface DeliveryReceipt {
    readonly mode: DeliveryMode;
    readonly location: string;
    readonly deliveredAt: string;
}
export declare class OutputDeliveryService {
    private readonly eventBus;
    private readonly uploadFile;
    private readonly sendWebhook;
    private readonly sendChannelReply;
    constructor(eventBus: TaskEventBus, uploadFile: (tenantId: string, localPath: string) => Promise<string>, // returns signed download URL
    sendWebhook: (url: string, payload: unknown) => Promise<void>, sendChannelReply: (replyTarget: unknown, message: string) => Promise<string>);
    deliver(payload: DeliveryPayload, config: DeliveryConfig): Promise<DeliveryReceipt>;
}
//# sourceMappingURL=OutputDeliveryService.d.ts.map