"use strict";
/**
 * DistributedContextStore — Redis-backed key-value store for cross-worker task state.
 *
 * Enables worker-restart resilience: if a worker crashes mid-task, the new worker
 * can load the last saved state and resume from the correct turn index rather than
 * starting over. Used by ConversationalLoop, GeneralCodingOrchestrator, and SwarmCoordinator.
 *
 * Keys are namespaced by purpose (e.g. `gc-session:{taskId}`, `gc-plan:{taskId}`).
 * Default TTL: 24 hours — sufficient for any single task's lifetime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributedContextStore = void 0;
const CONTEXT_TTL_SECONDS = 24 * 60 * 60;
class DistributedContextStore {
    redisGet;
    redisSetEx;
    redisDel;
    constructor(redisGet, redisSetEx, redisDel) {
        this.redisGet = redisGet;
        this.redisSetEx = redisSetEx;
        this.redisDel = redisDel;
    }
    async save(record) {
        await this.redisSetEx(record.id, CONTEXT_TTL_SECONDS, JSON.stringify(record));
    }
    async load(id) {
        const raw = await this.redisGet(id);
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    async delete(id) {
        await this.redisDel(id);
    }
}
exports.DistributedContextStore = DistributedContextStore;
//# sourceMappingURL=DistributedContextStore.js.map