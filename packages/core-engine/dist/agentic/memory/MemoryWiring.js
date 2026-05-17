"use strict";
/**
 * MemoryWiring — single entry point that constructs the four-tier memory
 * subsystem from environment-derived config.
 *
 * Closes gap analysis #1 (`MemoryOrchestrator` never instantiated) and #2
 * (`main.ts` stub with `null as never` deps). Replaces the broken inline
 * `new QdrantSemanticStore({ qdrant: null, embedder: null })` with a real
 * orchestrator that gracefully degrades when optional deps are missing:
 *
 *   • Tier 1 (WorkingMemoryRegistry) — always available.
 *   • Tier 2 (ShortTermMemoryStore)  — needs Redis. Always wired here.
 *   • Tier 3 (ProjectRegistry)       — needs Redis. Always wired here.
 *   • Tier 4 (QdrantSemanticStore)   — needs Qdrant + an Embedder. Wired
 *     only when `qdrantUrl` and an embedder are present. Otherwise the
 *     orchestrator omits the semantic tier; `record()` synthesises entries
 *     and `recall()` returns []. The contract still holds.
 *
 * Background services (decay, consolidator, promoter, warmer) are
 * constructed only when their preconditions hold (Qdrant for all four;
 * pg.Pool for decay's archival path). `start()` schedules them on
 * configurable intervals; `stop()` clears all timers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wireMemorySubsystem = wireMemorySubsystem;
const MemoryOrchestrator_js_1 = require("./MemoryOrchestrator.js");
const WorkingMemory_js_1 = require("./WorkingMemory.js");
const ShortTermMemoryStore_js_1 = require("./ShortTermMemoryStore.js");
const ProjectRegistry_js_1 = require("./ProjectRegistry.js");
const QdrantSemanticStore_js_1 = require("./QdrantSemanticStore.js");
const OllamaEmbedder_js_1 = require("./OllamaEmbedder.js");
const MemoryCircuitBreaker_js_1 = require("./MemoryCircuitBreaker.js");
const MemoryDecayService_js_1 = require("../MemoryDecayService.js");
const MemoryConsolidator_js_1 = require("../MemoryConsolidator.js");
const MemoryScopePromoter_js_1 = require("../MemoryScopePromoter.js");
const MemoryWarmer_js_1 = require("../MemoryWarmer.js");
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_LOGGER = {
    info: (...a) => console.log('[memory]', ...a),
    warn: (...a) => console.warn('[memory]', ...a),
    error: (...a) => console.error('[memory]', ...a),
    debug: () => undefined,
};
async function wireMemorySubsystem(cfg) {
    const logger = cfg.logger ?? DEFAULT_LOGGER;
    // ── Tiers 1–3: always wired ────────────────────────────────────────────────
    const working = new WorkingMemory_js_1.WorkingMemoryRegistry();
    // ShortTermMemoryStore and ProjectRegistry use a Redis duck-type subset; the
    // ioredis client satisfies it but TypeScript doesn't know that, so cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shortTerm = new ShortTermMemoryStore_js_1.ShortTermMemoryStore(cfg.redis);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projects = new ProjectRegistry_js_1.ProjectRegistry(cfg.redis);
    // ── Tier 4: optional ──────────────────────────────────────────────────────
    let qdrant = null;
    let embedder = null;
    let semantic = null;
    if (cfg.qdrantUrl) {
        try {
            const mod = await import('@qdrant/js-client-rest');
            qdrant = new mod.QdrantClient({
                url: cfg.qdrantUrl,
                // Skip the synchronous server-version handshake that the client
                // otherwise fires off in the constructor — we tolerate version
                // mismatches at runtime and don't want startup noise.
                checkCompatibility: false,
                ...(cfg.qdrantApiKey ? { apiKey: cfg.qdrantApiKey } : {}),
            });
        }
        catch (err) {
            logger.warn('Qdrant client construction failed; semantic tier disabled', err);
            qdrant = null;
        }
    }
    if (cfg.embedder) {
        embedder = cfg.embedder;
    }
    else if (cfg.ollamaUrl && cfg.embedModel) {
        const ollama = new OllamaEmbedder_js_1.OllamaEmbedder({
            baseUrl: cfg.ollamaUrl,
            model: cfg.embedModel,
            ...(cfg.vectorDimension ? { dimension: cfg.vectorDimension } : {}),
        });
        embedder = ollama.asEmbedder();
    }
    // Construct the optional in-process circuit breaker. Reused across the
    // semantic store and any service that ends up sharing the Qdrant client.
    const breaker = cfg.breaker === false
        ? undefined
        : new MemoryCircuitBreaker_js_1.MemoryCircuitBreaker('qdrant-semantic-store', {
            ...(cfg.breaker?.failureThreshold !== undefined ? { failureThreshold: cfg.breaker.failureThreshold } : {}),
            ...(cfg.breaker?.cooldownMs !== undefined ? { cooldownMs: cfg.breaker.cooldownMs } : {}),
        });
    if (qdrant && embedder) {
        // Build the store config — only set keys that are actually configured
        // so the store's defaults (vectorDimension=1536, strictSchema=false)
        // apply when the caller hasn't opted in.
        const storeConfig = {};
        if (cfg.vectorDimension)
            storeConfig['vectorDimension'] = cfg.vectorDimension;
        if (cfg.embedModel)
            storeConfig['embedderId'] = cfg.embedModel;
        if (cfg.strictSchema)
            storeConfig['strictSchema'] = cfg.strictSchema;
        semantic = new QdrantSemanticStore_js_1.QdrantSemanticStore({
            qdrant,
            embedder,
            ...(Object.keys(storeConfig).length > 0 ? { config: storeConfig } : {}),
            ...(breaker ? { breaker } : {}),
            ...(cfg.purgeAuditor ? { audit: cfg.purgeAuditor } : {}),
        });
        logger.info('semantic tier wired (Qdrant +', cfg.embedModel ?? 'custom embedder', ')');
    }
    else {
        logger.warn('semantic tier NOT wired:', !qdrant ? 'no QDRANT_URL' : '', !embedder ? 'no embedder' : '');
    }
    // ── Orchestrator ──────────────────────────────────────────────────────────
    const orchestrator = new MemoryOrchestrator_js_1.MemoryOrchestrator({
        working, shortTerm, projects,
        ...(semantic ? { semantic } : {}),
    });
    // ── Background services ────────────────────────────────────────────────────
    const services = {};
    const tenantIds = cfg.tenantIds ?? (async () => []);
    if (qdrant && embedder) {
        services.consolidator = new MemoryConsolidator_js_1.MemoryConsolidator(qdrant, embedder, MemoryConsolidator_js_1.DEFAULT_CONSOLIDATOR_CONFIG, tenantIds, logger);
        services.promoter = new MemoryScopePromoter_js_1.MemoryScopePromoter(qdrant, MemoryScopePromoter_js_1.DEFAULT_PROMOTER_CONFIG, tenantIds, logger);
        if (cfg.pgPool) {
            services.decay = new MemoryDecayService_js_1.MemoryDecayService(qdrant, cfg.pgPool, MemoryDecayService_js_1.DEFAULT_DECAY_CONFIG, tenantIds, logger);
        }
        else {
            logger.warn('MemoryDecayService not started: no pg.Pool provided');
        }
    }
    if (semantic) {
        services.warmer = new MemoryWarmer_js_1.MemoryWarmer(semantic, 
        // MemoryWarmer wants the legacy concrete ShortTermMemoryStore for its
        // recallSemanticTurns() method. The interface ShortTermMemoryStore
        // exposes is the same instance.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        shortTerm);
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    const intervals = [];
    const start = () => {
        if (services.decay) {
            const ms = cfg.schedules?.decayMs ?? WEEK_MS;
            intervals.push(setInterval(() => {
                services.decay.runDecayCycle().catch(e => logger.error('decay cycle failed', e));
            }, ms).unref?.() ?? intervals[intervals.length - 1]);
        }
        if (services.consolidator) {
            const ms = cfg.schedules?.consolidatorMs ?? DAY_MS;
            intervals.push(setInterval(() => {
                services.consolidator.runConsolidationCycle().catch(e => logger.error('consolidator cycle failed', e));
            }, ms).unref?.() ?? intervals[intervals.length - 1]);
        }
        if (services.promoter) {
            const ms = cfg.schedules?.promoterMs ?? DAY_MS;
            intervals.push(setInterval(() => {
                services.promoter.runPromotionCycle().catch(e => logger.error('promoter cycle failed', e));
            }, ms).unref?.() ?? intervals[intervals.length - 1]);
        }
        logger.info(`memory background services started (${Object.keys(services).filter(k => services[k]).length})`);
    };
    const stop = () => {
        for (const i of intervals)
            clearInterval(i);
        intervals.length = 0;
    };
    return { orchestrator, semantic, services, start, stop };
}
//# sourceMappingURL=MemoryWiring.js.map