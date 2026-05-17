"use strict";
// TODO(RFC): Phase D.2 — Thompson sampling bandit per slot.
// This stub always returns the channel-pointer hash (no exploration).
// Full implementation: Beta(α,β) posterior per (channel, slotId, promptHash),
// 5% forced exploration to newest GEPA-staged candidate.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BanditService = void 0;
class BanditService {
    pg;
    constructor(pg) {
        this.pg = pg;
    }
    /** Phase D.2 stub — returns undefined (caller falls back to channel pointer). */
    draw(_channel, _slotId, _taskId) {
        return undefined;
    }
    /** Phase D.2 stub — no-op. */
    recordReward(_taskId, _slotId, _armId, _reward) {
        return Promise.resolve();
    }
}
exports.BanditService = BanditService;
//# sourceMappingURL=BanditService.js.map