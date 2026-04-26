"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserEventStreamer = void 0;
class BrowserEventStreamer {
    bus;
    tenantId;
    sessionId;
    constructor(bus, tenantId, sessionId) {
        this.bus = bus;
        this.tenantId = tenantId;
        this.sessionId = sessionId;
    }
    emit(type, payload) {
        void this.bus.publish(`browser:${this.tenantId}:${this.sessionId}`, {
            type, ts: new Date().toISOString(), ...payload,
        });
    }
}
exports.BrowserEventStreamer = BrowserEventStreamer;
//# sourceMappingURL=BrowserEventStreamer.js.map