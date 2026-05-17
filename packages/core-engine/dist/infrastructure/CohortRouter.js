"use strict";
// DONE: Phase D.3 — Full CohortRouter implementation.
// Upgrades from Phase A.4 stub to production-ready per-tenant channel selection
// with LRU cache, Redis-invalidation, BanditService integration, and in-flight pinning.
//
// Invariant §2.8: returns stable-v0 on any failure — never throws into task path.
Object.defineProperty(exports, "__esModule", { value: true });
exports.STABLE_V0_FALLBACKS = exports.CohortRouter = void 0;
const core_contracts_1 = require("@oweibo/core-contracts");
const crypto_1 = require("crypto");
class LRUCache {
    map = new Map();
    maxSize;
    ttlMs;
    constructor(maxSize = 500, ttlMs = 60_000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.map.delete(key);
            return undefined;
        }
        // Move to end (LRU eviction)
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        if (this.map.size >= this.maxSize) {
            // Evict oldest (first) entry
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
    invalidate(predicate) {
        for (const key of this.map.keys()) {
            if (predicate(key))
                this.map.delete(key);
        }
    }
}
// ── CohortRouter ─────────────────────────────────────────────────────────────
class CohortRouter {
    registry;
    assembler;
    forceChannel;
    bandit;
    onInvalidate;
    operationalMode;
    cache = new LRUCache(500, 60_000);
    constructor(registry, assembler, forceChannel, bandit, 
    /** Optional Redis subscribe callback for cache invalidation (≤60s lag). */
    onInvalidate, 
    /** Optional operational mode service — enforces §17.5.1 state machine. */
    operationalMode) {
        this.registry = registry;
        this.assembler = assembler;
        this.forceChannel = forceChannel;
        this.bandit = bandit;
        this.onInvalidate = onInvalidate;
        this.operationalMode = operationalMode;
        // Subscribe to channel-pointer invalidation messages from Redis
        this.onInvalidate?.((msg) => {
            try {
                const { role, slotId } = JSON.parse(msg);
                if (role && slotId) {
                    this.cache.invalidate(k => k.startsWith(`${role}:${slotId}:`));
                }
                else {
                    // Full flush
                    this.cache.invalidate(() => true);
                }
            }
            catch { /* ignore malformed messages */ }
        });
    }
    /**
     * Resolve prompt version for a single role.
     * Checks LRU cache first; falls back to stable-v0 on any error.
     */
    async resolveForRole(role, taskId, channel = 'stable-v0') {
        // §17.5.1 Mode 0: Full freeze — return stable-v0 directly regardless of channel.
        // Fail-open: if mode cannot be read, proceed normally (OperationalModeService.getMode() never throws).
        if (this.operationalMode) {
            const mode = await this.operationalMode.getMode();
            if (mode === 0) {
                return {
                    promptText: exports.STABLE_V0_FALLBACKS[role] ?? '',
                    assembledHash: 'stable-v0',
                    channel: 'stable-v0',
                    slotPins: [],
                };
            }
        }
        const effectiveChannel = this.forceChannel ?? channel;
        const cacheKey = `${role}:${effectiveChannel}:${taskId.slice(0, 8)}`;
        const cached = this.cache.get(cacheKey);
        if (cached)
            return cached;
        try {
            // Phase D.3: Use BanditService to select which arm (prompt) to use
            let resolvedChannel = effectiveChannel;
            if (this.bandit && effectiveChannel !== 'stable-v0') {
                const slots = SLOTS_FOR_ROLE[role] ?? [];
                const firstSlot = slots[0];
                if (firstSlot) {
                    const seed = parseInt((0, crypto_1.createHash)('sha256').update(`${taskId}:${firstSlot}`).digest('hex').slice(0, 8), 16);
                    const draw = await this.bandit.draw({
                        slotId: firstSlot,
                        channel: effectiveChannel,
                        role,
                        rngSeed: seed,
                    });
                    resolvedChannel = draw.channel;
                }
            }
            const { text, hash, slotHashes } = await this.assembler.assembleForChannel(role, resolvedChannel, 'stable-v0');
            const slotPins = Object.entries(slotHashes).map(([slotId, promptHash]) => ({
                slotId,
                promptHash,
                templateVersion: 'stable-v0',
            }));
            const resolution = {
                promptText: text,
                assembledHash: hash,
                channel: resolvedChannel,
                slotPins,
            };
            this.cache.set(cacheKey, resolution);
            return resolution;
        }
        catch (err) {
            console.warn(`[CohortRouter] resolveForRole failed for ${role}/${effectiveChannel}: ${String(err)}; falling back to stable-v0`);
            return {
                promptText: exports.STABLE_V0_FALLBACKS[role] ?? '',
                assembledHash: 'stable-v0',
                channel: 'stable-v0',
                slotPins: [],
            };
        }
    }
    /** Resolve all four roles atomically. Used by SwarmCoordinator.startTask(). */
    async resolveAllRoles(taskId, channel = 'stable-v0') {
        const entries = await Promise.all(core_contracts_1.CANONICAL_ROLES.map(async (role) => [role, await this.resolveForRole(role, taskId, channel)]));
        return Object.fromEntries(entries);
    }
}
exports.CohortRouter = CohortRouter;
/** Slot IDs for each canonical role (§7.3 slot inventory). */
const SLOTS_FOR_ROLE = {
    architect: ['decomposition_rules', 'tool_selection_rubric', 'error_recovery_template'],
    executor: ['tool_arg_construction', 'intermediate_state_check', 'failure_handling'],
    reviewer: ['defect_taxonomy', 'severity_rubric', 'acceptance_criteria'],
    decomposer: ['subgoal_granularity_guide', 'dependency_inference_rules'],
};
/** Last-resort static fallbacks (§2.8). */
exports.STABLE_V0_FALLBACKS = {
    architect: 'You are the Architect agent. Decompose goals into a precise, ordered plan.',
    executor: 'You are the Executor agent. Carry out plan steps faithfully and report results.',
    reviewer: 'You are the Reviewer agent. Audit executor outputs and challenge defects.',
    decomposer: 'You are a task decomposer. Break a software goal into ordered sub-goals. Each sub-goal has: description, toolName (optional), input (optional object), dependsOn (array of descriptions it depends on). Output JSON array only.',
};
//# sourceMappingURL=CohortRouter.js.map