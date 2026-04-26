// packages/browser-tool/src/streaming/BrowserEventStreamer.ts
// Publishes browser-* lifecycle events onto the channel-contracts event bus
// so live UIs (Cockpit, CLI watch mode) can stream session activity (§9).
import type { IBrowserEventEmitter } from '@oweibo/core-contracts';

export interface IEventBus {
  publish(channel: string, payload: Record<string, unknown>): Promise<void>;
}

export class BrowserEventStreamer implements IBrowserEventEmitter {
  constructor(
    private readonly bus: IEventBus,
    private readonly tenantId: string,
    private readonly sessionId: string,
  ) {}

  emit(type: string, payload: Record<string, unknown>): void {
    void this.bus.publish(`browser:${this.tenantId}:${this.sessionId}`, {
      type, ts: new Date().toISOString(), ...payload,
    });
  }
}
