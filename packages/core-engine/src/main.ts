// packages/core-engine/src/main.ts
// Full startup sequence — wires all services and starts the API server + channel gateway.
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';
import { SecretsManager }          from './secrets/SecretsManager.js';
import { NullVaultClient }         from './infrastructure/VaultClient.js';
import { DistributedContextStore } from './agentic/DistributedContextStore.js';
import { TaskQueue }               from './agentic/TaskQueue.js';
import { IntentPipeline }          from './ingestion/IntentPipeline.js';
import { IntentClarifier }         from './ingestion/IntentClarifier.js';
import { TaskEventBus }            from './ingestion/TaskEventBus.js';
import { TaskInterventionGateway } from './ingestion/TaskInterventionGateway.js';
import { OutputDeliveryService }   from './ingestion/OutputDeliveryService.js';
import { SessionStore }            from './ingestion/SessionStore.js';
import { CognitiveEngine }         from './agentic/CognitiveEngine.js';
import { SwarmCoordinator }        from './agentic/SwarmCoordinator.js';
import { GoalDecomposer }          from './agentic/GoalDecomposer.js';
import { MultiStrategyPlanner }    from './agentic/MultiStrategyPlanner.js';
import { wireMemorySubsystem }      from './agentic/memory/MemoryWiring.js';
import { ContextPruner }           from './agentic/ContextPruner.js';
import { TaskHeartbeat }           from './agentic/TaskHeartbeat.js';
import { HeartbeatScanner }        from './agentic/HeartbeatScanner.js';
import { HITLGateway }             from './governance/HITLGateway.js';
import { ImmutableAuditLogger }    from './governance/ImmutableAuditLogger.js';
import { PolicyEngine }            from './governance/PolicyEngine.js';
import { AnomalyDetector }         from './observability/AnomalyDetector.js';
import { SandboxFactory }          from './sandbox/SandboxFactory.js';
import { TieredWarmPoolManager }   from './sandbox/TieredWarmPoolManager.js';
import { InstrumentedLLMClient }   from './agentic/InstrumentedLLMClient.js';
import { ConflictResolver }        from './agentic/ConflictResolver.js';
import { GeneralCodingOrchestrator } from './general-coding/GeneralCodingOrchestrator.js';
import { SkillRegistry }           from './general-coding/project/SkillRegistry.js';
import { RemoteSkillFetcher }      from './general-coding/project/RemoteSkillFetcher.js';
import { ModelRouter }             from './infrastructure/ModelRouter.js';
import { Pool }                    from 'pg';
import { CohortRouter }            from './infrastructure/CohortRouter.js';
import { OperationalModeService }  from './infrastructure/OperationalModeService.js';
import { BanditService }           from './bandit/BanditService.js';
import { PromotionGateService }    from './bandit/PromotionGateService.js';
import { MutationGovernanceService } from './governance/MutationGovernanceService.js';
import { CohortAdminService }       from './infrastructure/CohortAdminService.js';
import { GepaInspectorService }     from './bandit/GepaInspectorService.js';
import { PrivacyAuditService }      from './distillation/PrivacyAuditService.js';
import { ActionTrustLadder }        from './action/ActionTrustLadder.js';
import { DryRunRegistry }           from './action/DryRunRegistry.js';
import { ShadowExecutor }           from './action/ShadowExecutor.js';
import { PromptRegistry }          from '@oweibo/prompt-registry';
import { PromptAssembler }         from '@oweibo/prompt-registry';
import { createServer }            from './api/server.js';
import { DocGeneratorPipeline }    from './doc-generator/DocGeneratorPipeline.js';
import { DocGeneratorQueue }       from './doc-generator/queue/DocGeneratorQueue.js';
import { DocGeneratorWorker }      from './doc-generator/queue/DocGeneratorWorker.js';
import { SessionReaper }           from './doc-generator/queue/SessionReaper.js';
import { RedisTaskEventBus }       from './infrastructure/eventbus/RedisTaskEventBus.js';
import { AuditLogger }             from './doc-generator/observability/AuditLogger.js';
import { createDocsRouter }        from './doc-generator/http/docsRouter.js';

async function main(): Promise<void> {
  // ── Infrastructure ────────────────────────────────────────────────────────
  const vault   = new NullVaultClient();
  const secrets = new SecretsManager(vault);

  // ── Redis ─────────────────────────────────────────────────────────────────
  const ioredis = await import('ioredis');
  const RedisClass = (ioredis.default ?? ioredis) as any;
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis: any = new RedisClass(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  await redis.connect().catch(() => {
    console.warn('[oweibo] Redis not available — some features will degrade gracefully');
  });

  // Redis callback adapters
  const rGet    = (key: string) => redis.get(key) as Promise<string | null>;
  const rSet    = (key: string, value: string) => (redis.set(key, value) as Promise<unknown>).then(() => undefined as void);
  const rSetEx  = (key: string, ttl: number, value: string) => (redis.setex(key, ttl, value) as Promise<unknown>).then(() => undefined as void);
  const rDel    = (key: string) => (redis.del(key) as Promise<unknown>).then(() => undefined as void);
  const rPub    = (channel: string, msg: string) => (redis.publish(channel, msg) as Promise<unknown>).then(() => undefined as void);
  const rSub    = (channel: string, handler: (msg: string) => void) =>
    (redis.subscribe(channel) as Promise<unknown>).then(() => {
      redis.on('message', (ch: string, msg: string) => { if (ch === channel) handler(msg); });
      return async () => { await redis.unsubscribe(channel); };
    });
  const rLPush  = (key: string, value: string) => (redis.lpush(key, value) as Promise<unknown>).then(() => undefined as void);
  const rBRPop  = (keys: string[], timeout: number) =>
    (redis.brpop(...keys, timeout) as Promise<[string, string] | null>);
  const rPeek   = (key: string) => redis.lindex(key, -1) as Promise<string | null>;

  // ── Core stores ───────────────────────────────────────────────────────────
  const contextStore        = new DistributedContextStore(redis);
  const sessionStore        = new SessionStore(rGet, rSetEx);
  const eventBus            = new TaskEventBus(rPub, rSub);
  const interventionGateway = new TaskInterventionGateway(rSet, rGet, rSetEx, rDel, rGet);
  const queue               = new TaskQueue(rLPush, rBRPop, rPeek, () => ['default']);

  // ── LLM client factory ────────────────────────────────────────────────────
  const llmBase = {
    baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434',
    model:   process.env.LLM_MODEL   ?? 'ollama/mistral',
  };
  const makeLLM = () => new InstrumentedLLMClient(llmBase.baseUrl, llmBase.model, null as never);

  // ── Output delivery ───────────────────────────────────────────────────────
  const delivery = new OutputDeliveryService(
    eventBus,
    async () => '',        // uploadFile stub
    async () => undefined, // sendWebhook stub
    async () => '',        // sendChannelReply stub
  );

  // ── Intent pipeline ───────────────────────────────────────────────────────
  const clarifier      = new IntentClarifier(makeLLM());
  const intentPipeline = new IntentPipeline(clarifier, eventBus, interventionGateway, queue);

  // ── Governance ────────────────────────────────────────────────────────────
  const hitlGateway  = new HITLGateway(redis);
  const auditLogger  = new ImmutableAuditLogger('global');
  const policyEngine = new PolicyEngine();
  const anomaly      = new AnomalyDetector();

  // ── Sandbox ───────────────────────────────────────────────────────────────
  const sandboxFactory = new SandboxFactory(secrets);
  const warmPool       = new TieredWarmPoolManager(sandboxFactory);
  warmPool.start();

  // ── Memory subsystem (4-tier orchestrator + background services) ─────────
  // Tier 1 + 2 + 3 always wired; tier 4 (Qdrant) wired when QDRANT_URL is set
  // and an embedder is available.
  const memorySubsystem = await wireMemorySubsystem({
    redis,
    ...(process.env.QDRANT_URL    ? { qdrantUrl:    process.env.QDRANT_URL } : {}),
    ...(process.env.QDRANT_API_KEY ? { qdrantApiKey: process.env.QDRANT_API_KEY } : {}),
    ...(process.env.OLLAMA_URL    ? { ollamaUrl:    process.env.OLLAMA_URL } : {}),
    ...(process.env.OWEIBO_EMBED_MODEL ? { embedModel:  process.env.OWEIBO_EMBED_MODEL } : {}),
    ...(process.env.OWEIBO_EMBED_DIM   ? { vectorDimension: Number(process.env.OWEIBO_EMBED_DIM) } : {}),
  });
  memorySubsystem.start();
  // Legacy ISemanticMemoryStore reference for SwarmCoordinator/CognitiveEngine
  // — these still take the tier-4 store directly during the broader migration
  // to consume IMemoryOrchestrator. When the semantic tier isn't wired they
  // get a no-op store that records nothing (matches the orchestrator's
  // graceful-degradation contract).
  const memory: any = memorySubsystem.semantic ?? {
    store:        async () => ({ id: '', scope: { tenantId: '' }, kind: 'domain-fact', summary: '', importance: 0, createdAt: '', updatedAt: '', recallCount: 0 }),
    recall:       async () => [],
    purgeTenant:  async () => undefined,
    purgeProject: async () => undefined,
    purgeUser:    async () => undefined,
  };

  // ── Agentic core ─────────────────────────────────────────────────────────
  const planner    = new MultiStrategyPlanner(makeLLM());
  const decomposer = new GoalDecomposer(makeLLM());
  const pruner     = new ContextPruner(contextStore);

  const conflictResolver = new ConflictResolver(makeLLM(), hitlGateway);

  // ── Prompt registry + cohort router (Phase A.4) ───────────────────────────
  let pgPool: Pool | undefined;
  let cohortRouter: CohortRouter | undefined;
  let operationalMode: OperationalModeService | undefined;
  let promotionGate: PromotionGateService | undefined;
  let mutationGovernance: MutationGovernanceService | undefined;
  let cohortAdmin: CohortAdminService | undefined;
  let gepaInspector: GepaInspectorService | undefined;
  let privacyAudit: PrivacyAuditService | undefined;
  let actionTrustLadder: ActionTrustLadder | undefined;
  let dryRunRegistry: DryRunRegistry | undefined;
  let shadowExecutor: ShadowExecutor | undefined;
  if (process.env['DATABASE_URL']) {
    pgPool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const promptRegistry = new PromptRegistry(
      pgPool,
      process.env['LANGFUSE_SECRET_KEY'],
      process.env['LANGFUSE_PUBLIC_KEY'],
    );
    const promptAssembler = new PromptAssembler(promptRegistry);
    cohortRouter = new CohortRouter(promptRegistry, promptAssembler);
    operationalMode = new OperationalModeService(pgPool, rPub, rSub);
    const banditService = new BanditService(pgPool, operationalMode);
    promotionGate = new PromotionGateService(pgPool, banditService);
    mutationGovernance = new MutationGovernanceService(pgPool);
    cohortAdmin = new CohortAdminService(pgPool);
    gepaInspector = new GepaInspectorService(pgPool);
    privacyAudit = new PrivacyAuditService(pgPool);
    // T.−1: action trust ladder. Disabled by env flag until shadow-only rollout
    // completes — gate() returns {mode:'execute'} when ACTION_TRUST_LADDER_ENABLED
    // is not 'true', so the wrap is byte-identical to today for callers.
    actionTrustLadder = new ActionTrustLadder(pgPool);
    dryRunRegistry = new DryRunRegistry(pgPool);
    shadowExecutor = new ShadowExecutor(pgPool);
  }

  const swarm = new SwarmCoordinator(
    llmBase, memory, policyEngine, anomaly, auditLogger,
    conflictResolver, eventBus, interventionGateway, decomposer, contextStore, sessionStore,
    pgPool, cohortRouter,
    undefined,    // safetyChecker — wired in a future revision
    cohortAdmin,  // D.1 — resolves per-tenant cohort_channel at task start
  );

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeat = new TaskHeartbeat(redis);
  const scanner   = new HeartbeatScanner(redis, async () => undefined, async () => undefined);
  scanner.start();

  // ── ModelRouter + Skills ──────────────────────────────────────────────────
  const modelRouter   = new ModelRouter(secrets);
  const skillFetcher  = new RemoteSkillFetcher(process.cwd());
  void skillFetcher;
  const skillRegistry = new SkillRegistry(modelRouter, null as never, redis, vault);

  // ── General coding orchestrator ───────────────────────────────────────────
  const generalCodingOrchestrator = new GeneralCodingOrchestrator(
    null as never, null as never, null as never,
    skillRegistry, null as never, null as never,
    null as never, null as never,
    eventBus, interventionGateway, contextStore, warmPool as never,
  );

  // ── CognitiveEngine ───────────────────────────────────────────────────────
  const engine = new CognitiveEngine(
    llmBase, planner, decomposer, memory, policyEngine, anomaly,
    contextStore, pruner, swarm, eventBus, sessionStore, delivery,
    heartbeat, generalCodingOrchestrator,
  );
  (queue as any).startWorker?.(engine, 5);

  // ── Doc-generator subsystem (B3 multi-pod startup guard) ────────────────────
  //
  // B3: If DOC_GEN_EVENT_BUS_MODE=redis, a separate Redis pub/sub pair is required so
  // SSE events published by pod-A are received by clients connected to pod-B.
  // We validate the pub/sub connection before accepting traffic (fail-fast).
  // If the env var is absent or 'memory', the in-memory TaskEventBus is used — this
  // works correctly for single-replica deployments.
  const docGenEventBusMode = process.env['DOC_GEN_EVENT_BUS_MODE'] ?? 'memory';
  let docGenEventBus: any = eventBus;
  let docGenWorker: DocGeneratorWorker | undefined;
  let docGenReaper: SessionReaper | undefined;

  if (docGenEventBusMode === 'redis') {
    // Separate clients required by Redis pub/sub protocol — must not reuse main redis.
    const docPub: any = new RedisClass(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    const docSub: any = new RedisClass(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    try {
      await docPub.connect();
      await docSub.connect();
      console.log('[oweibo] Doc-gen event bus: Redis pub/sub connected (multi-pod mode)');
    } catch (err) {
      console.error('[oweibo] B3 STARTUP GUARD FAILED: could not connect doc-gen Redis pub/sub:', err);
      process.exit(1);
    }
    docGenEventBus = new RedisTaskEventBus(docPub, docSub, console as any);
  } else {
    console.log('[oweibo] Doc-gen event bus: in-memory (single-pod mode)');
  }

  const docGenQueue = new DocGeneratorQueue(redis as any, {
    dailyTokenQuota: Number(process.env['DOC_GEN_DAILY_TOKEN_QUOTA'] ?? 500_000),
  });
  const docGenAudit   = new AuditLogger();
  const docGenPipeline = new DocGeneratorPipeline({
    llm:               makeLLM() as any,
    eventBus:          docGenEventBus,
    logger:            console as any,
    globalTokenBudget: Number(process.env['DOC_GEN_GLOBAL_TOKEN_BUDGET'] ?? 80_000),
  });

  docGenWorker = new DocGeneratorWorker(
    docGenPipeline,
    docGenQueue,
    redis as any,
    console as any,
  );

  docGenReaper = new SessionReaper(
    docGenQueue,
    docGenEventBus,
    redis as any,
    console as any,
  );

  docGenReaper.start();
  void docGenWorker.start();

  // ── HTTP server ───────────────────────────────────────────────────────────
  await createServer({
    secrets,
    intentPipeline: intentPipeline as any,
    taskEventBus:   eventBus as any,
    interventionGateway: interventionGateway as any,
    hitlGateway,
    ...(pgPool && operationalMode ? { pool: pgPool, operationalMode } : {}),
    ...(promotionGate      ? { promotionGate }      : {}),
    ...(mutationGovernance ? { mutationGovernance } : {}),
    ...(cohortAdmin        ? { cohortAdmin }        : {}),
    ...(gepaInspector      ? { gepaInspector }      : {}),
    ...(privacyAudit       ? { privacyAudit }       : {}),
    ...(actionTrustLadder && dryRunRegistry && shadowExecutor
      ? { actionTrustLadder, dryRunRegistry, shadowExecutor }
      : {}),
  });

  // ── Channel Gateway (optional) ────────────────────────────────────────────
  try {
    const { startGateway } = await import('@oweibo/channel-gateway' as any);
    const gatewayManager: any = await startGateway({
      secrets, redis, intentPipeline, eventBus,
      interventionGw: interventionGateway, contextStore,
      initialRegistrations: [],
    });
    process.on('SIGTERM', async () => {
      await gatewayManager.shutdown?.();
      await redis.quit();
      process.exit(0);
    });
  } catch {
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
