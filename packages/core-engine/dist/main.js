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
const LongTermMemoryStore_js_1 = require("./agentic/LongTermMemoryStore.js");
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
const server_js_1 = require("./api/server.js");
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
    // ── Agentic core ─────────────────────────────────────────────────────────
    const memory = new LongTermMemoryStore_js_1.LongTermMemoryStore(null, null);
    const planner = new MultiStrategyPlanner_js_1.MultiStrategyPlanner(makeLLM());
    const decomposer = new GoalDecomposer_js_1.GoalDecomposer(makeLLM());
    const pruner = new ContextPruner_js_1.ContextPruner(contextStore);
    const conflictResolver = new ConflictResolver_js_1.ConflictResolver(makeLLM(), hitlGateway);
    const swarm = new SwarmCoordinator_js_1.SwarmCoordinator(llmBase, memory, policyEngine, anomaly, auditLogger, conflictResolver, eventBus, interventionGateway, decomposer, contextStore, sessionStore);
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
    // ── HTTP server ───────────────────────────────────────────────────────────
    await (0, server_js_1.createServer)({
        secrets,
        intentPipeline: intentPipeline,
        taskEventBus: eventBus,
        interventionGateway: interventionGateway,
        hitlGateway,
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
        scanner.stop();
        warmPool.stop();
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