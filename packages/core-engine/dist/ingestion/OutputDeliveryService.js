"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputDeliveryService = void 0;
class OutputDeliveryService {
    eventBus;
    uploadFile;
    sendWebhook;
    sendChannelReply;
    constructor(eventBus, uploadFile, // returns signed download URL
    sendWebhook, sendChannelReply) {
        this.eventBus = eventBus;
        this.uploadFile = uploadFile;
        this.sendWebhook = sendWebhook;
        this.sendChannelReply = sendChannelReply;
    }
    async deliver(payload, config) {
        let receipt;
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
                    taskId: payload.taskId,
                    tenantId: payload.tenantId,
                    summary: payload.summary,
                    content: payload.artifactContent,
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
                const exhaustive = config.mode;
                throw new Error(`[OutputDeliveryService] Unknown delivery mode: ${exhaustive}`);
            }
        }
        await this.eventBus.publish(payload.sessionId, {
            taskId: payload.taskId,
            type: 'output-ready',
            message: `Output delivered via ${receipt.mode}: ${receipt.location}`,
            payload: { receipt },
        });
        return receipt;
    }
}
exports.OutputDeliveryService = OutputDeliveryService;
//# sourceMappingURL=OutputDeliveryService.js.map