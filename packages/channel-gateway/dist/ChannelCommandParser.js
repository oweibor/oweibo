"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelCommandParser = void 0;
/**
 * Supported slash commands (plain chat messages starting with /):
 *   /pause <taskId>              → pause the running task
 *   /cancel <taskId>             → cancel the running task
 *   /redirect <taskId> <text>    → redirect with a new instruction
 *   /approve <taskId>            → approve a plan-ready gate
 *   /status                      → list active tasks for this user
 *
 * Ownership check: task:{taskId}:userId Redis key must match the caller's resolved userId.
 */
class ChannelCommandParser {
    gateway;
    adapters;
    redis;
    constructor(gateway, adapters, redis) {
        this.gateway = gateway;
        this.adapters = adapters;
        this.redis = redis;
    }
    async parse(msg, _tenantId, userId) {
        const parts = msg.text.trim().split(/\s+/);
        const command = parts[0]?.toLowerCase();
        const taskId = parts[1];
        const reply = async (text) => {
            await this.adapters.get(msg.platform)?.sendMessage(msg.botToken, msg.platformChatId, text);
        };
        if (command === '/status') {
            await reply(`Send \`/cancel <taskId>\` or \`/redirect <taskId> <instruction>\` to intervene in a running task.`);
            return;
        }
        if (!taskId) {
            await reply(`Usage: ${command} <taskId> [instruction]`);
            return;
        }
        const taskOwner = await this.redis.get(`task:${taskId}:userId`);
        if (taskOwner !== userId) {
            await reply(`❌ Task \`${taskId}\` not found or not owned by you.`);
            return;
        }
        const { createHash } = await import('crypto');
        const replyTarget = {
            platform: msg.platform,
            botTokenHash: createHash('sha256').update(msg.botToken).digest('hex'),
            chatId: msg.platformChatId,
            threadId: msg.messageId,
            _botToken: msg.botToken, // stored transiently for ChannelEventBridge routing
        };
        switch (command) {
            case '/pause':
                await this.gateway.submit({
                    taskId, userId, type: 'pause', instruction: 'paused-by-user',
                    timestamp: Date.now(), source: 'channel', channelReplyTarget: replyTarget,
                });
                await reply(`⏸ Task paused. Reply \`/redirect ${taskId} <new instruction>\` to resume with changes, or \`/cancel ${taskId}\` to abort.`);
                break;
            case '/cancel':
                await this.gateway.submit({
                    taskId, userId, type: 'cancel', instruction: 'cancelled-by-user',
                    timestamp: Date.now(), source: 'channel', channelReplyTarget: replyTarget,
                });
                await reply(`🛑 Task cancelled.`);
                break;
            case '/redirect': {
                const instruction = parts.slice(2).join(' ');
                if (!instruction) {
                    await reply(`Usage: /redirect <taskId> <new instruction>`);
                    return;
                }
                await this.gateway.submit({
                    taskId, userId, type: 'redirect', instruction,
                    timestamp: Date.now(), source: 'channel', channelReplyTarget: replyTarget,
                });
                await reply(`↩️ Redirecting: _${instruction}_`);
                break;
            }
            case '/approve':
                await this.gateway.submit({
                    taskId, userId, type: 'add-constraint', instruction: 'APPROVED',
                    timestamp: Date.now(), source: 'channel', channelReplyTarget: replyTarget,
                });
                await reply(`✅ Plan approved — continuing.`);
                break;
            default:
                await reply(`Unknown command. Available: /pause /cancel /redirect /approve /status`);
        }
    }
}
exports.ChannelCommandParser = ChannelCommandParser;
//# sourceMappingURL=ChannelCommandParser.js.map