import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class GoogleChatAdapter implements IChannelAdapter {
    readonly platform: "googlechat";
    private readonly handlers;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    /** Called by the webhook router for /webhooks/googlechat/{tenantId} */
    handleWebhook(token: string, payload: Record<string, unknown>): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
}
//# sourceMappingURL=GoogleChatAdapter.d.ts.map