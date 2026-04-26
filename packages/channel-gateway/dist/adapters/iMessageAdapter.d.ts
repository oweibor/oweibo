import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class iMessageAdapter implements IChannelAdapter {
    readonly platform: "imessage";
    private readonly handlers;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    /** Called by the webhook router. Edge forwarder strips external headers before forwarding. */
    handleWebhook(token: string, payload: Record<string, unknown>): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
}
//# sourceMappingURL=iMessageAdapter.d.ts.map