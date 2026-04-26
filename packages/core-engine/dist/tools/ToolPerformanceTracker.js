"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolPerformanceTracker = void 0;
class ToolPerformanceTracker {
    qdrant;
    embedFn;
    COLLECTION = 'tool-performance';
    constructor(qdrant, embedFn) {
        this.qdrant = qdrant;
        this.embedFn = embedFn;
    }
    async record(rec) {
        try {
            const vector = await this.embedFn(`${rec.toolName} ${rec.taskContext}`);
            await this.qdrant.upsert(this.COLLECTION, {
                points: [{ id: `${rec.toolName}-${rec.timestamp}`, vector, payload: rec }],
            });
        }
        catch {
            // Non-fatal — performance tracking should never break the tool call
        }
    }
    async rankForContext(query, candidates, topK = 5) {
        try {
            const vector = await this.embedFn(query);
            const results = await this.qdrant.search(this.COLLECTION, {
                vector,
                limit: 200,
                with_payload: true,
                filter: { must: [{ key: 'toolName', match: { any: candidates } }] },
            });
            const scores = {};
            for (const r of results) {
                const p = r.payload;
                const toolName = p['toolName'];
                const success = p['success'];
                if (!toolName)
                    continue;
                if (!scores[toolName])
                    scores[toolName] = { successes: 0, total: 0 };
                scores[toolName].total++;
                if (success)
                    scores[toolName].successes++;
            }
            return candidates
                .sort((a, b) => {
                const ra = (scores[a]?.successes ?? 0) / (scores[a]?.total ?? 1);
                const rb = (scores[b]?.successes ?? 0) / (scores[b]?.total ?? 1);
                return rb - ra;
            })
                .slice(0, topK);
        }
        catch {
            return candidates.slice(0, topK);
        }
    }
}
exports.ToolPerformanceTracker = ToolPerformanceTracker;
//# sourceMappingURL=ToolPerformanceTracker.js.map