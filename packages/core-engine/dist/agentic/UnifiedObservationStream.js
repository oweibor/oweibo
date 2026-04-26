"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnifiedObservationStream = void 0;
// packages/core-engine/src/agentic/UnifiedObservationStream.ts
const eventemitter3_1 = require("eventemitter3");
const crypto_1 = require("crypto");
class UnifiedObservationStream extends eventemitter3_1.EventEmitter {
    buffer = [];
    MAX_BUFFER = 1000;
    add(source, type, data, correlationId) {
        const obs = {
            id: (0, crypto_1.randomUUID)(),
            timestamp: Date.now(),
            source,
            type,
            data,
            correlationId,
        };
        this.buffer.push(obs);
        if (this.buffer.length > this.MAX_BUFFER)
            this.buffer.shift();
        this.emit('observation', obs);
        return obs;
    }
    recent(n, filter) {
        let obs = this.buffer;
        if (filter?.source)
            obs = obs.filter(o => o.source === filter.source);
        if (filter?.type)
            obs = obs.filter(o => o.type === filter.type);
        return obs.slice(-n);
    }
    buildContextWindow(maxTokens) {
        const lines = [];
        let tokenEstimate = 0;
        for (const obs of [...this.buffer].reverse()) {
            const line = `[${obs.source}/${obs.type}] ${JSON.stringify(obs.data)}`;
            const tokens = Math.ceil(line.length / 4);
            if (tokenEstimate + tokens > maxTokens)
                break;
            lines.unshift(line);
            tokenEstimate += tokens;
        }
        return lines.join('\n');
    }
}
exports.UnifiedObservationStream = UnifiedObservationStream;
//# sourceMappingURL=UnifiedObservationStream.js.map