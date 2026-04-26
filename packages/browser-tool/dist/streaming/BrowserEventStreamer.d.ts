import type { IBrowserEventEmitter } from '@oweibo/core-contracts';
export interface IEventBus {
    publish(channel: string, payload: Record<string, unknown>): Promise<void>;
}
export declare class BrowserEventStreamer implements IBrowserEventEmitter {
    private readonly bus;
    private readonly tenantId;
    private readonly sessionId;
    constructor(bus: IEventBus, tenantId: string, sessionId: string);
    emit(type: string, payload: Record<string, unknown>): void;
}
//# sourceMappingURL=BrowserEventStreamer.d.ts.map