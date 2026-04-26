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
  readonly artifactPath?: string;       // local path to zip/tar if applicable
  readonly artifactContent?: unknown;   // in-memory content for small payloads
  readonly summary: string;
}

export interface DeliveryReceipt {
  readonly mode: DeliveryMode;
  readonly location: string;            // URL, branch name, or channel message ID
  readonly deliveredAt: string;
}

export class OutputDeliveryService {
  constructor(
    private readonly eventBus: TaskEventBus,
    private readonly uploadFile: (
      tenantId: string,
      localPath: string,
    ) => Promise<string>,                // returns signed download URL
    private readonly sendWebhook: (
      url: string,
      payload: unknown,
    ) => Promise<void>,
    private readonly sendChannelReply: (
      replyTarget: unknown,
      message: string,
    ) => Promise<string>,               // returns message ID
  ) {}

  async deliver(
    payload: DeliveryPayload,
    config: DeliveryConfig,
  ): Promise<DeliveryReceipt> {
    let receipt: DeliveryReceipt;

    switch (config.mode) {
      case 'download-link': {
        if (!payload.artifactPath) {
          throw new Error('[OutputDeliveryService] artifactPath required for download-link delivery');
        }
        const url = await this.uploadFile(payload.tenantId, payload.artifactPath);
        receipt = { mode: 'download-link', location: url, deliveredAt: new Date().toISOString() };
        break;
      }

      case 'git-push': {
        // Git push is handled by GitAdapter and EditApplicator during the task;
        // here we just record the branch that was pushed.
        const branch = config.gitBranch ?? `oweibo/${payload.taskId}`;
        receipt = { mode: 'git-push', location: `${config.gitRepoUrl ?? 'local'}#${branch}`, deliveredAt: new Date().toISOString() };
        break;
      }

      case 'webhook': {
        if (!config.webhookUrl) {
          throw new Error('[OutputDeliveryService] webhookUrl required for webhook delivery');
        }
        await this.sendWebhook(config.webhookUrl, {
          taskId:    payload.taskId,
          tenantId:  payload.tenantId,
          summary:   payload.summary,
          content:   payload.artifactContent,
          timestamp: new Date().toISOString(),
        });
        receipt = { mode: 'webhook', location: config.webhookUrl, deliveredAt: new Date().toISOString() };
        break;
      }

      case 'channel-reply': {
        if (!config.channelReplyTarget) {
          throw new Error('[OutputDeliveryService] channelReplyTarget required for channel-reply delivery');
        }
        const messageId = await this.sendChannelReply(config.channelReplyTarget, payload.summary);
        receipt = { mode: 'channel-reply', location: messageId, deliveredAt: new Date().toISOString() };
        break;
      }

      default: {
        const exhaustive: never = config.mode;
        throw new Error(`[OutputDeliveryService] Unknown delivery mode: ${exhaustive}`);
      }
    }

    await this.eventBus.publish(payload.sessionId, {
      taskId:  payload.taskId,
      type:    'output-ready',
      message: `Output delivered via ${receipt.mode}: ${receipt.location}`,
      payload: { receipt },
    });

    return receipt;
  }
}
