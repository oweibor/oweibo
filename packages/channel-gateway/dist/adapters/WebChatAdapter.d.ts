import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';
export declare class WebChatAdapter implements IChannelAdapter {
    readonly platform: "webchat";
    private wss;
    private readonly connections;
    private readonly handlers;
    start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void>;
    stop(_token: string): Promise<void>;
    sendMessage(_token: string, chatId: string, text: string): Promise<void>;
    sendTypingIndicator(_token: string, chatId: string): Promise<void>;
}
//# sourceMappingURL=WebChatAdapter.d.ts.map