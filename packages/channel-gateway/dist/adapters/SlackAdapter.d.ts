import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class SlackAdapter implements IChannelAdapter {
    readonly platform: "slack";
    private readonly apps;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(token: string): Promise<void>;
    sendMessage(token: string, chatId: string, text: string): Promise<void>;
}
//# sourceMappingURL=SlackAdapter.d.ts.map