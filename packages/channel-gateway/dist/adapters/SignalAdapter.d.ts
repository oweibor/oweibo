import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class SignalAdapter implements IChannelAdapter {
    readonly platform: "signal";
    private readonly pollers;
    private readonly handlers;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
}
//# sourceMappingURL=SignalAdapter.d.ts.map