"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// packages/core-engine/src/main.ts
// Full startup sequence — wires all services and starts the API server + channel gateway.
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
require("dotenv/config");
const SecretsManager_js_1 = require("./secrets/SecretsManager.js");
const VaultClient_js_1 = require("./infrastructure/VaultClient.js");
const DistributedContextStore_js_1 = require("./agentic/DistributedContextStore.js");
const TaskQueue_js_1 = require("./agentic/TaskQueue.js");
const IntentPipeline_js_1 = require("./ingestion/IntentPipeline.js");
const IntentClarifier_js_1 = require("./ingestion/IntentClarifier.js");
const TaskEventBus_js_1 = require("./ingestion/TaskEventBus.js");
const TaskInterventionGateway_js_1 = require("./ingestion/TaskInterventionGateway.js");
const OutputDeliveryService_js_1 = require("./ingestion/OutputDeliveryService.js");
const SessionStore_js_1 = require("./ingestion/SessionStore.js");
const CognitiveEngine_js_1 = require("./agentic/CognitiveEngine.js");
const SwarmCoordinator_js_1 = require("./agentic/SwarmCoordinator.js");
const GoalDecomposer_js_1 = require("./agentic/GoalDecomposer.js");
const MultiStrategyPlanner_js_1 = require("./agentic/MultiStrategyPlanner.js");
const MemoryWiring_js_1 = require("./agentic/memory/MemoryWiring.js");
const ContextPruner_js_1 = require("./agentic/ContextPruner.js");
const TaskHeartbeat_js_1 = require("./agentic/TaskHeartbeat.js");
const HeartbeatScanner_js_1 = require("./agentic/HeartbeatScanner.js");
const HITLGateway_js_1 = require("./governance/HITLGateway.js");
const ImmutableAuditLogger_js_1 = require("./governance/ImmutableAuditLogger.js");
const PolicyEngine_js_1 = require("./governance/PolicyEngine.js");
const AnomalyDetector_js_1 = require("./observability/AnomalyDetector.js");
const SandboxFactory_js_1 = require("./sandbox/SandboxFactory.js");
const TieredWarmPoolManager_js_1 = require("./sandbox/TieredWarmPoolManager.js");
const InstrumentedLLMClient_js_1 = require("./agentic/InstrumentedLLMClient.js");
const ConflictResolver_js_1 = require("./agentic/ConflictResolver.js");
const GeneralCodingOrchestrator_js_1 = require("./general-coding/GeneralCodingOrchestrator.js");
const SkillRegistry_js_1 = require("./general-coding/project/SkillRegistry.js");
const RemoteSkillFetcher_js_1 = require("./general-coding/project/RemoteSkillFetcher.js");
const ModelRouter_js_1 = require("./infrastructure/ModelRouter.js");
const pg_1 = require("pg");
const CohortRouter_js_1 = require("./infrastructure/CohortRouter.js");
const OperationalModeService_js_1 = require("./infrastructure/OperationalModeService.js");
const BanditService_js_1 = require("./bandit/BanditService.js");
const PromotionGateService_js_1 = require("./bandit/PromotionGateService.js");
const MutationGovernanceService_js_1 = require("./governance/MutationGovernanceService.js");
const CohortAdminService_js_1 = require("./infrastructure/CohortAdminService.js");
const GepaInspectorService_js_1 = require("./bandit/GepaInspectorService.js");
const PrivacyAuditService_js_1 = require("./distillation/PrivacyAuditService.js");
const ActionTrustLadder_js_1 = require("./action/ActionTrustLadder.js");
const DryRunRegistry_js_1 = require("./action/DryRunRegistry.js");
const ShadowExecutor_js_1 = require("./action/ShadowExecutor.js");
const prompt_registry_1 = require("@oweibo/prompt-registry");
const prompt_registry_2 = require("@oweibo/prompt-registry");
const server_js_1 = require("./api/server.js");
const DocGeneratorPipeline_js_1 = require("./doc-generator/DocGeneratorPipeline.js");
const DocGeneratorQueue_js_1 = require("./doc-generator/queue/DocGeneratorQueue.js");
const DocGeneratorWorker_js_1 = require("./doc-generator/queue/DocGeneratorWorker.js");
const SessionReaper_js_1 = require("./doc-generator/queue/SessionReaper.js");
const RedisTaskEventBus_js_1 = require("./infrastructure/eventbus/RedisTaskEventBus.js");
const AuditLogger_js_1 = require("./doc-generator/observability/AuditLogger.js");
async function main() {
    // ── Infrastructure ────────────────────────────────────────────────────────
    const vault = new VaultClient_js_1.NullVaultClient();
    const secrets = new SecretsManager_js_1.SecretsManager(vault);
    // ── Redis ─────────────────────────────────────────────────────────────────
    const ioredis = await import('ioredis');
    const RedisClass = (ioredis.default ?? ioredis);
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    await redis.connect().catch(() => {
        console.warn('[oweibo] Redis not available — some features will degrade gracefully');
    });
    // Redis callback adapters
    const rGet = (key) => redis.get(key);
    const rSet = (key, value) => redis.set(key, value).then(() => undefined);
    const rSetEx = (key, ttl, value) => redis.setex(key, ttl, value).then(() => undefined);
    const rDel = (key) => redis.del(key).then(() => undefined);
    const rPub = (channel, msg) => redis.publish(channel, msg).then(() => undefined);
    const rSub = (channel, handler) => redis.subscribe(channel).then(() => {
        redis.on('message', (ch, msg) => { if (ch === channel)
            handler(msg); });
        return async () => { await redis.unsubscribe(channel); };
    });
    const rLPush = (key, value) => redis.lpush(key, value).then(() => undefined);
    const rBRPop = (keys, timeout) => redis.brpop(...keys, timeout);
    const rPeek = (key) => redis.lindex(key, -1);
    // ── Core stores ───────────────────────────────────────────────────────────
    const contextStore = new DistributedContextStore_js_1.DistributedContextStore(redis);
    const sessionStore = new SessionStore_js_1.SessionStore(rGet, rSetEx);
    const eventBus = new TaskEventBus_js_1.TaskEventBus(rPub, rSub);
    const interventionGateway = new TaskInterventionGateway_js_1.TaskInterventionGateway(rSet, rGet, rSetEx, rDel, rGet);
    const queue = new TaskQueue_js_1.TaskQueue(rLPush, rBRPop, rPeek, () => ['default']);
    // ── LLM client factory ────────────────────────────────────────────────────
    const llmBase = {
        baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434',
        model: process.env.LLM_MODEL ?? 'ollama/mistral',
    };
    const makeLLM = () => new InstrumentedLLMClient_js_1.InstrumentedLLMClient(llmBase.baseUrl, llmBase.model, null);
    // ── Output delivery ───────────────────────────────────────────────────────
    const delivery = new OutputDeliveryService_js_1.OutputDeliveryService(eventBus, async () => '', // uploadFile stub
    async () => undefined, // sendWebhook stub
    async () => '');
    // ── Intent pipeline ───────────────────────────────────────────────────────
    const clarifier = new IntentClarifier_js_1.IntentClarifier(makeLLM());
    const intentPipeline = new IntentPipeline_js_1.IntentPipeline(clarifier, eventBus, interventionGateway, queue);
    // ── Governance ────────────────────────────────────────────────────────────
    const hitlGateway = new HITLGateway_js_1.HITLGateway(redis);
    const auditLogger = new ImmutableAuditLogger_js_1.ImmutableAuditLogger('global');
    const policyEngine = new PolicyEngine_js_1.PolicyEngine();
    const anomaly = new AnomalyDetector_js_1.AnomalyDetector();
    // ── Sandbox ───────────────────────────────────────────────────────────────
    const sandboxFactory = new SandboxFactory_js_1.SandboxFactory(secrets);
    const warmPool = new TieredWarmPoolManager_js_1.TieredWarmPoolManager(sandboxFactory);
    warmPool.start();
    // ── Memory subsystem (4-tier orchestrator + background services) ─────────
    // Tier 1 + 2 + 3 always wired; tier 4 (Qdrant) wired when QDRANT_URL is set
    // and an embedder is available.
    const memorySubsystem = await (0, MemoryWiring_js_1.wireMemorySubsystem)({
        redis,
        ...(process.env.QDRANT_URL ? { qdrantUrl: process.env.QDRANT_URL } : {}),
        ...(process.env.QDRANT_API_KEY ? { qdrantApiKey: process.env.QDRANT_API_KEY } : {}),
        ...(process.env.OLLAMA_URL ? { ollamaUrl: process.env.OLLAMA_URL } : {}),
        ...(process.env.OWEIBO_EMBED_MODEL ? { embedModel: process.env.OWEIBO_EMBED_MODEL } : {}),
        ...(process.env.OWEIBO_EMBED_DIM ? { vectorDimension: Number(process.env.OWEIBO_EMBED_DIM) } : {}),
    });
    memorySubsystem.start();
    // Legacy ISemanticMemoryStore reference for SwarmCoordinator/CognitiveEngine
    // — these still take the tier-4 store directly during the broader migration
    // to consume IMemoryOrchestrator. When the semantic tier isn't wired they
    // get a no-op store that records nothing (matches the orchestrator's
    // graceful-degradation contract).
    const memory = memorySubsystem.semantic ?? {
        store: async () => ({ id: '', scope: { tenantId: '' }, kind: 'domain-fact', summary: '', importance: 0, createdAt: '', updatedAt: '', recallCount: 0 }),
        recall: async () => [],
        purgeTenant: async () => undefined,
        purgeProject: async () => undefined,
        purgeUser: async () => undefined,
    };
    // ── Agentic core ─────────────────────────────────────────────────────────
    const planner = new MultiStrategyPlanner_js_1.MultiStrategyPlanner(makeLLM());
    const decomposer = new GoalDecomposer_js_1.GoalDecomposer(makeLLM());
    const pruner = new ContextPruner_js_1.ContextPruner(contextStore);
    const conflictResolver = new ConflictResolver_js_1.ConflictResolver(makeLLM(), hitlGateway);
    // ── Prompt registry + cohort router (Phase A.4) ───────────────────────────
    let pgPool;
    let cohortRouter;
    let operationalMode;
    let promotionGate;
    let mutationGovernance;
    let cohortAdmin;
    let gepaInspector;
    let privacyAudit;
    let actionTrustLadder;
    let dryRunRegistry;
    let shadowExecutor;
    if (process.env['DATABASE_URL']) {
        pgPool = new pg_1.Pool({ connectionString: process.env['DATABASE_URL'] });
        const promptRegistry = new prompt_registry_1.PromptRegistry(pgPool, process.env['LANGFUSE_SECRET_KEY'], process.env['LANGFUSE_PUBLIC_KEY']);
        const promptAssembler = new prompt_registry_2.PromptAssembler(promptRegistry);
        cohortRouter = new CohortRouter_js_1.CohortRouter(promptRegistry, promptAssembler);
        operationalMode = new OperationalModeService_js_1.OperationalModeService(pgPool, rPub, rSub);
        const banditService = new BanditService_js_1.BanditService(pgPool, operationalMode);
        promotionGate = new PromotionGateService_js_1.PromotionGateService(pgPool, banditService);
        mutationGovernance = new MutationGovernanceService_js_1.MutationGovernanceService(pgPool);
        cohortAdmin = new CohortAdminService_js_1.CohortAdminService(pgPool);
        gepaInspector = new GepaInspectorService_js_1.GepaInspectorService(pgPool);
        privacyAudit = new PrivacyAuditService_js_1.PrivacyAuditService(pgPool);
        // T.−1: action trust ladder. Disabled by env flag until shadow-only rollout
        // completes — gate() returns {mode:'execute'} when ACTION_TRUST_LADDER_ENABLED
        // is not 'true', so the wrap is byte-identical to today for callers.
        actionTrustLadder = new ActionTrustLadder_js_1.ActionTrustLadder(pgPool);
        dryRunRegistry = new DryRunRegistry_js_1.DryRunRegistry(pgPool);
        shadowExecutor = new ShadowExecutor_js_1.ShadowExecutor(pgPool);
    }
    const swarm = new SwarmCoordinator_js_1.SwarmCoordinator(llmBase, memory, policyEngine, anomaly, auditLogger, conflictResolver, eventBus, interventionGateway, decomposer, contextStore, sessionStore, pgPool, cohortRouter, undefined, // safetyChecker — wired in a future revision
    cohortAdmin);
    // ── Heartbeat ─────────────────────────────────────────────────────────────
    const heartbeat = new TaskHeartbeat_js_1.TaskHeartbeat(redis);
    const scanner = new HeartbeatScanner_js_1.HeartbeatScanner(redis, async () => undefined, async () => undefined);
    scanner.start();
    // ── ModelRouter + Skills ──────────────────────────────────────────────────
    const modelRouter = new ModelRouter_js_1.ModelRouter(secrets);
    const skillFetcher = new RemoteSkillFetcher_js_1.RemoteSkillFetcher(process.cwd());
    void skillFetcher;
    const skillRegistry = new SkillRegistry_js_1.SkillRegistry(modelRouter, null, redis, vault);
    // ── General coding orchestrator ───────────────────────────────────────────
    const generalCodingOrchestrator = new GeneralCodingOrchestrator_js_1.GeneralCodingOrchestrator(null, null, null, skillRegistry, null, null, null, null, eventBus, interventionGateway, contextStore, warmPool);
    // ── CognitiveEngine ───────────────────────────────────────────────────────
    const engine = new CognitiveEngine_js_1.CognitiveEngine(llmBase, planner, decomposer, memory, policyEngine, anomaly, contextStore, pruner, swarm, eventBus, sessionStore, delivery, heartbeat, generalCodingOrchestrator);
    queue.startWorker?.(engine, 5);
    // ── Doc-generator subsystem (B3 multi-pod startup guard) ────────────────────
    //
    // B3: If DOC_GEN_EVENT_BUS_MODE=redis, a separate Redis pub/sub pair is required so
    // SSE events published by pod-A are received by clients connected to pod-B.
    // We validate the pub/sub connection before accepting traffic (fail-fast).
    // If the env var is absent or 'memory', the in-memory TaskEventBus is used — this
    // works correctly for single-replica deployments.
    const docGenEventBusMode = process.env['DOC_GEN_EVENT_BUS_MODE'] ?? 'memory';
    let docGenEventBus = eventBus;
    let docGenWorker;
    let docGenReaper;
    if (docGenEventBusMode === 'redis') {
        // Separate clients required by Redis pub/sub protocol — must not reuse main redis.
        const docPub = new RedisClass(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
        const docSub = new RedisClass(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
        try {
            await docPub.connect();
            await docSub.connect();
            console.log('[oweibo] Doc-gen event bus: Redis pub/sub connected (multi-pod mode)');
        }
        catch (err) {
            console.error('[oweibo] B3 STARTUP GUARD FAILED: could not connect doc-gen Redis pub/sub:', err);
            process.exit(1);
        }
        docGenEventBus = new RedisTaskEventBus_js_1.RedisTaskEventBus(docPub, docSub, console);
    }
    else {
        console.log('[oweibo] Doc-gen event bus: in-memory (single-pod mode)');
    }
    const docGenQueue = new DocGeneratorQueue_js_1.DocGeneratorQueue(redis, {
        dailyTokenQuota: Number(process.env['DOC_GEN_DAILY_TOKEN_QUOTA'] ?? 500_000),
    });
    const docGenAudit = new AuditLogger_js_1.AuditLogger();
    const docGenPipeline = new DocGeneratorPipeline_js_1.DocGeneratorPipeline({
        llm: makeLLM(),
        eventBus: docGenEventBus,
        logger: console,
        globalTokenBudget: Number(process.env['DOC_GEN_GLOBAL_TOKEN_BUDGET'] ?? 80_000),
    });
    docGenWorker = new DocGeneratorWorker_js_1.DocGeneratorWorker(docGenPipeline, docGenQueue, redis, console);
    docGenReaper = new SessionReaper_js_1.SessionReaper(docGenQueue, docGenEventBus, redis, console);
    docGenReaper.start();
    void docGenWorker.start();
    // ── HTTP server ───────────────────────────────────────────────────────────
    await (0, server_js_1.createServer)({
        secrets,
        intentPipeline: intentPipeline,
        taskEventBus: eventBus,
        interventionGateway: interventionGateway,
        hitlGateway,
        ...(pgPool && operationalMode ? { pool: pgPool, operationalMode } : {}),
        ...(promotionGate ? { promotionGate } : {}),
        ...(mutationGovernance ? { mutationGovernance } : {}),
        ...(cohortAdmin ? { cohortAdmin } : {}),
        ...(gepaInspector ? { gepaInspector } : {}),
        ...(privacyAudit ? { privacyAudit } : {}),
        ...(actionTrustLadder && dryRunRegistry && shadowExecutor
            ? { actionTrustLadder, dryRunRegistry, shadowExecutor }
            : {}),
    });
    // ── Channel Gateway (optional) ────────────────────────────────────────────
    try {
        const { startGateway } = await import('@oweibo/channel-gateway');
        const gatewayManager = await startGateway({
            secrets, redis, intentPipeline, eventBus,
            interventionGw: interventionGateway, contextStore,
            initialRegistrations: [],
        });
        process.on('SIGTERM', async () => {
            await gatewayManager.shutdown?.();
            await redis.quit();
            process.exit(0);
        });
    }
    catch {
        console.warn('[oweibo] Channel gateway not available — starting without it');
    }
    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const shutdown = async () => {
        docGenWorker?.stop();
        docGenReaper?.stop();
        scanner.stop();
        warmPool.stop();
        memorySubsystem.stop();
        await redis.quit();
        process.exit(0);
    };
    process.on('SIGTERM', async () => { console.log('[oweibo] SIGTERM'); await shutdown(); });
    process.on('SIGINT', shutdown);
}
main().catch(err => {
    console.error('[oweibo] Fatal startup error:', err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map