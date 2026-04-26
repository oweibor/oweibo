"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextPruner = void 0;
class ContextPruner {
    contextStore;
    static MAX_MESSAGES = 20;
    constructor(contextStore) {
        this.contextStore = contextStore;
    }
    async pruneIfNeeded(taskId, trace) {
        const ctx = await this.contextStore.load(taskId);
        if (!ctx)
            return;
        const messages = ctx.agentMessages ?? [];
        if (messages.length <= ContextPruner.MAX_MESSAGES)
            return;
        // Keep first 5 (planning context) and last 10 (most recent execution context)
        const pruned = [
            ...messages.slice(0, 5),
            { type: 'system', payload: `[${messages.length - 15} messages pruned to fit context window]` },
            ...messages.slice(-10),
        ];
        await this.contextStore.save({ ...ctx, agentMessages: pruned });
    }
}
exports.ContextPruner = ContextPruner;
//# sourceMappingURL=ContextPruner.js.map