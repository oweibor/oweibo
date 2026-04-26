import type { InboundChannelMessage, IChannelAdapter } from './adapters/IChannelAdapter.js';
import type { Platform, ChannelReplyTarget } from '@oweibo/channel-contracts';
import type { Redis } from 'ioredis';
export interface TaskIntervention {
    taskId: string;
    userId: string;
    type: 'pause' | 'cancel' | 'redirect' | 'add-constraint';
    instruction: string;
    timestamp: number;
    source: 'channel';
    channelReplyTarget: ChannelReplyTarget & {
        _botToken?: string;
    };
}
export interface ITaskInterventionGatewayGateway {
    submit(intervention: TaskIntervention): Promise<void>;
}
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
export declare class ChannelCommandParser {
    private readonly gateway;
    private readonly adapters;
    private readonly redis;
    constructor(gateway: ITaskInterventionGatewayGateway, adapters: Map<Platform, IChannelAdapter>, redis: Redis);
    parse(msg: InboundChannelMessage, _tenantId: string, userId: string): Promise<void>;
}
//# sourceMappingURL=ChannelCommandParser.d.ts.map