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
import { ApprovalSlaService }       from './action/ApprovalSlaService.js';
import { MultiPartyApprovalService } from './action/MultiPartyApprovalService.js';
import { QuotaService }             from './action/QuotaService.js';
import { BudgetEstimator }          from './action/BudgetEstimator.js';
import { RateLimiter }              from './action/RateLimiter.js';
import { InMemoryTokenBucketStore } from './action/TokenBucketStore.js';
import { ContentInspectorRegistry } from './action/ContentInspectorRegistry.js';
import { GenericPiiInspector }      from './action/inspectors/GenericPiiInspector.js';
import { EmailContentInspector }    from './action/inspectors/EmailContentInspector.js';
import { SqlContentInspector }      from './action/inspectors/SqlContentInspector.js';
import { GitContentInspector }      from './action/inspectors/GitContentInspector.js';
import { DeploymentContentInspector } from './action/inspectors/DeploymentContentInspector.js';
import { FinancialContentInspector } from './action/inspectors/FinancialContentInspector.js';
import { OutboxRelay }              from './infrastructure/OutboxRelay.js';
import { ForensicPacketBuilder }     from './action/ForensicPacketBuilder.js';
import { HitlHandoffService }        from './action/HitlHandoffService.js';
import { resolveForensicStorageFromEnv } from './action/storage/ForensicPacketStorage.js';
import { hmacPacketSignerFromSecrets } from './action/storage/PacketSigner.js';
import { RollbackOrchestrator, RollbackAdapterRegistry } from './action/RollbackOrchestrator.js';
import { NoOpRollbackAdapter }       from './action/rollback-adapters/NoOpRollbackAdapter.js';
import { PostgresRollbackAdapter }   from './action/rollback-adapters/PostgresRollbackAdapter.js';
import { GitRollbackAdapter }        from './action/rollback-adapters/GitRollbackAdapter.js';
import { SlackRollbackAdapter }      from './action/rollback-adapters/SlackRollbackAdapter.js';
import { DeployRollbackAdapter }     from './action/rollback-adapters/DeployRollbackAdapter.js';
import { GenericWebhookRollbackAdapter } from './action/rollback-adapters/GenericWebhookRollbackAdapter.js';
import { PostExecutionVerifierService, InMemoryVerifierRegistry } from './action/PostExecutionVerifierService.js';
import { DeployHealthCheckVerifier } from './action/verifiers/DeployHealthCheckVerifier.js';
import { EmailDeliveredVerifier }    from './action/verifiers/EmailDeliveredVerifier.js';
import { PostgresRowCountVerifier }  from './action/verifiers/PostgresRowCountVerifier.js';
import { ComplianceRuleEvaluator }   from './domain/ComplianceRuleEvaluator.js';
import { ComplianceRulePackRegistry } from './domain/ComplianceRulePackRegistry.js';
import { PgTenantDomainBindingLookup } from './domain/PgTenantDomainBindingLookup.js';
import { CalibrationService }        from './infrastructure/CalibrationService.js';
import { TtvMetricsService }         from './observability/TtvMetricsService.js';
import { DomainCurrencyMonitor }     from './domain/DomainCurrencyMonitor.js';
import { DomainDepthMetrics }        from './domain/DomainDepthMetrics.js';
import { SmeFeedbackAggregator }     from './domain/SmeFeedbackAggregator.js';
import { SmeReviewService }          from './domain/SmeReviewService.js';
import { runWithAdvisoryLock }       from './infrastructure/runWithAdvisoryLock.js';
import {
  HmacSnapshotSigner,
  HmacSnapshotVerifier,
  loadHmacSnapshotKeys,
}                                    from './action/HmacSnapshotVerifier.js';
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
  let multiPartyApproval: MultiPartyApprovalService | undefined;
  let quotaService: QuotaService | undefined;
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
    // T.−1: action trust ladder + S.1–S.7 + D.3 integrations.
    //
    // Each integration is independently flag-gated inside the
    // construct-and-pass pattern below. Disabled-by-flag means the
    // integration is constructed but its tryConsume/preflight/evaluate
    // short-circuits to allow/no_grant/pass — the gate stays
    // byte-identical-to-today when ACTION_TRUST_LADDER_ENABLED=false.
    const slaService = new ApprovalSlaService(pgPool);
    multiPartyApproval = new MultiPartyApprovalService(pgPool);
    quotaService = new QuotaService(pgPool);
    const budgetEstimator = new BudgetEstimator(pgPool);
    // In-memory token bucket is per-process — multi-replica deployments
    // MUST replace this with RedisTokenBucketStore (see file header).
    // Surfaced as a startup warning instead of failing closed so
    // single-replica dev/test deployments keep working.
    if (process.env['ACTION_RATE_LIMITING_ENABLED'] === 'true'
        && process.env['NODE_ENV'] === 'production') {
      console.warn('[oweibo] ACTION_RATE_LIMITING_ENABLED=true with in-memory token bucket — multi-replica deployments will NOT enforce a global rate limit; wire RedisTokenBucketStore for production');
    }
    const tokenBucket = new InMemoryTokenBucketStore();
    const rateLimiter = new RateLimiter(pgPool, tokenBucket);
    const contentInspectors = new ContentInspectorRegistry();
    contentInspectors.register(new GenericPiiInspector());
    contentInspectors.register(new EmailContentInspector());
    contentInspectors.register(new SqlContentInspector());
    contentInspectors.register(new GitContentInspector());
    contentInspectors.register(new DeploymentContentInspector());
    contentInspectors.register(new FinancialContentInspector());
    // ── F.2.5: ComplianceRuleEvaluator + tenant-domain binding lookup ─────
    //
    // ComplianceRulePackRegistry loads the v1 in-memory packs (fintech,
    // healthcare, legal — see D.3). PgTenantDomainBindingLookup (F.1.8)
    // resolves per-tenant bound domain slugs from oweibo.tenant_domain_binding.
    // The evaluator's default bypass resolver is scopeBasedBypassResolver
    // (declared in ComplianceRuleEvaluator.ts) — it reads
    // ctx.principalScopes and matches against rule.bypassPolicy.
    const tenantDomainLookup = new PgTenantDomainBindingLookup(pgPool);
    const compliancePackRegistry = new ComplianceRulePackRegistry(undefined, {
      tenantDomainLookup: (t) => tenantDomainLookup.forTenant(t),
    });
    const complianceRuleEvaluator = new ComplianceRuleEvaluator(compliancePackRegistry);

    // ── F.3.1: CalibrationService + snapshot signer/verifier ───────────────
    //
    // The signer/verifier pair share key material from
    // infra/calibration-signer in Vault. When the key is unavailable
    // (NullVaultClient in dev, secret missing in prod) the wiring
    // gracefully degrades:
    //   - CalibrationService falls back to its legacy sourceKey HMAC,
    //     producing snapshots the gate's verifier will REJECT.
    //   - ActionTrustLadder.snapshotVerifier stays undefined.
    // The gate's existing fallback (cold-start defaults on verify
    // failure) absorbs both branches without blocking legitimate work.
    let snapshotSigner: HmacSnapshotSigner | undefined;
    let snapshotVerifier: HmacSnapshotVerifier | undefined;
    try {
      const keys = await loadHmacSnapshotKeys(secrets);
      snapshotSigner   = new HmacSnapshotSigner(keys);
      snapshotVerifier = new HmacSnapshotVerifier(keys);
    } catch (err) {
      console.warn('[oweibo] snapshot signer/verifier dormant:',
        err instanceof Error ? err.message : String(err));
    }
    const calibrationService = new CalibrationService(pgPool, {
      ...(snapshotSigner ? { snapshotSigner } : {}),
    });
    void calibrationService;  // wired into the task-create path in a follow-up;
                              // F.3.1's scope is the construction site.

    // ── F.3.2: TtvMetricsService — time-to-value telemetry ─────────────────
    //
    // The service auto-detects @opentelemetry/api at construction. When
    // present, all 14 metric series are real OTEL histograms/counters;
    // when absent, every record() call lands on a no-op and the wider
    // observability path stays silent. Operators wire the OTEL exporter
    // (Prometheus, OTLP, etc.) via the SDK config outside this code —
    // standard OTEL SDK env vars apply.
    //
    // The service is referenced via void today; threading the instance
    // into call sites (bootstrap worker, cognitive engine, action gate)
    // is per-caller work and ships as those callers are refactored.
    const ttvMetrics = new TtvMetricsService();
    if (!ttvMetrics.hasMeter) {
      console.warn(
        '[oweibo] TtvMetricsService: @opentelemetry/api not present — TTV ' +
        'metrics will not be emitted (NoOp histograms/counters). ' +
        'Install @opentelemetry/api + a matching exporter (e.g. ' +
        '@opentelemetry/exporter-prometheus) to enable.',
      );
    } else {
      console.log('[oweibo] TtvMetricsService: OTEL meter wired (14 metric series).');
    }
    void ttvMetrics;

    // ── F.3.3: periodic domain services ────────────────────────────────────
    //
    // DomainCurrencyMonitor.tick() walks the domain_artifact_currency table
    // daily and emits transitions. The cron is gated by a Postgres advisory
    // lock so concurrent triggers on multi-replica deployments are no-ops.
    //
    // DomainDepthMetrics and SmeFeedbackAggregator are per-event services
    // (writeSnapshot / aggregateForQueueItem) rather than tick-driven —
    // they're constructed here so the admin-web routes (F.4) and the SME
    // review flow can take them via runtime composition, but no periodic
    // tick is wired for them.
    const domainCurrencyMonitor    = new DomainCurrencyMonitor(pgPool);
    const domainDepthMetrics       = new DomainDepthMetrics(pgPool);
    const smeFeedbackAggregator    = new SmeFeedbackAggregator(pgPool);
    // F.3.4: SmeReviewService handles the per-queue-item review lifecycle
    // (enqueue → reviewers vote → aggregation via SmeFeedbackAggregator).
    // Constructed here so the F.4 /domains/sme-review admin routes can
    // take it via runtime composition.
    const smeReviewService         = new SmeReviewService(pgPool);
    void domainDepthMetrics;        // wired into F.4 admin-web /domains/depth route
    void smeFeedbackAggregator;     // wired into F.4 admin-web /domains/sme-review route
    void smeReviewService;          // wired into F.4 admin-web /domains/sme-review route

    // Daily DomainCurrency tick. node-cron is a CJS module; import via the
    // existing 'node-cron' dep without pulling type machinery into the
    // composition root.
    const cronExpr = process.env['DOMAIN_CURRENCY_CRON'] ?? '0 2 * * *';  // daily 02:00 UTC
    if (cronExpr.toLowerCase() === 'off' || cronExpr === '') {
      console.log('[oweibo] DomainCurrencyMonitor cron disabled (DOMAIN_CURRENCY_CRON=off)');
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cron = require('node-cron') as { schedule(expr: string, fn: () => void): unknown };
      cron.schedule(cronExpr, () => {
        void runWithAdvisoryLock(pgPool!, 'domain_currency_tick', async () => {
          const r = await domainCurrencyMonitor.tick();
          console.log('[oweibo] DomainCurrencyMonitor.tick():', {
            artifactsScanned: r.artifactsScanned,
            feedsAttempted:   r.feedsAttempted,
            transitions:      r.transitions.length,
            feedFailures:     r.feedFailures.length,
          });
        }).catch((err: unknown) => {
          console.error('[oweibo] DomainCurrencyMonitor.tick() failed:',
            err instanceof Error ? err.message : String(err));
        });
      });
      console.log(`[oweibo] DomainCurrencyMonitor cron scheduled: ${cronExpr}`);
    }

    actionTrustLadder = new ActionTrustLadder(pgPool, {
      slaAttacher: slaService,
      rateLimiter: { tryConsume: (t, c) => rateLimiter.tryConsume(t, c) },
      grantChecker: { tryConsume: (req) => multiPartyApproval.tryConsume(req) },
      contentInspectors: { run: (ctx) => contentInspectors.run(ctx) },
      quotaService: { preflight: (args) => quotaService.preflight(args) },
      budgetEstimator: { estimate: (args) => budgetEstimator.estimate(args) },
      complianceRuleEvaluator,
      ...(snapshotVerifier ? { snapshotVerifier } : {}),
    });
    dryRunRegistry = new DryRunRegistry(pgPool);
    shadowExecutor = new ShadowExecutor(pgPool);

    // ── F.2.3: forensic packet pipeline + HITL handoff ────────────────────
    //
    // Storage backend is selected via OWEIBO_FORENSIC_STORAGE_KIND
    // (filesystem|s3|none). When the kind resolves to none/undefined the
    // forensic features stay dormant — the HITL routes will surface
    // 'forensic_features_disabled' to operators. Signer requires
    // infra/forensic-signer in Vault (CALIBRATION_SIGNING_KEY equivalent
    // for packets); without it we skip construction with a startup warning.
    let forensicBuilder: ForensicPacketBuilder | undefined;
    let hitlHandoff:     HitlHandoffService     | undefined;
    let forensicStorage: import('@oweibo/core-contracts').IForensicPacketStorage | undefined;
    try {
      forensicStorage = resolveForensicStorageFromEnv();
      if (forensicStorage) {
        const signer = await hmacPacketSignerFromSecrets(secrets);
        forensicBuilder = new ForensicPacketBuilder(pgPool, forensicStorage, signer);
        hitlHandoff     = new HitlHandoffService(pgPool, forensicBuilder);
      }
    } catch (err) {
      console.warn('[oweibo] forensic packet pipeline disabled:',
        err instanceof Error ? err.message : String(err));
    }
    // forensicBuilder is consumed by hitlHandoff; suppress unused-var
    // when the wiring is dormant.
    void forensicBuilder;

    // ── F.2.4: PostExecutionVerifierService + 3 production verifiers ──────
    //
    // Registry is populated with the three verifier impls. Each verifier
    // takes per-action config via deferred_verifications.verifier_config,
    // so adding a verifier here doesn't fire it for every action — only
    // for actions whose adapter populated the matching config.
    //
    // autoHitlHandoff routes severity-3 outcomes on AUTO_HITL_TRIGGER_CLASSES
    // (financial.*, irreversible.*, deploy.prod*) to hitlHandoff.prepare.
    // The hook is undefined when the forensic pipeline is dormant
    // (storage / signer not wired) — the verifier service no-ops in that case.
    const verifierRegistry = new InMemoryVerifierRegistry();
    verifierRegistry.register(new DeployHealthCheckVerifier());
    verifierRegistry.register(new EmailDeliveredVerifier());
    verifierRegistry.register(new PostgresRowCountVerifier(pgPool));
    const postExecVerifier = new PostExecutionVerifierService(pgPool, verifierRegistry, {
      ...(hitlHandoff ? {
        autoHitlHandoff: async (args) => {
          const planId = args.proposalId; // single-action proposals: planId == proposalId fallback
          await hitlHandoff!.prepare({
            tenantId: args.tenantId,
            planId,
            triggerKind: 'auto_drift',
            triggeredBy: 'post_execution_verifier',
            ...(args.reason ? { summary: args.reason } : {}),
          });
          return { ok: true };
        },
      } : {}),
    });
    void postExecVerifier;  // wired into the lifecycle worker via runtime composition

    // ── F.2.2: rollback orchestrator + full adapter registry ──────────────
    //
    // Adapters that need per-tenant external config (slack token,
    // deploy service URL, webhook destination) take resolver shims that
    // return null until F.1.6 resolvers + F.4 admin routes are wired
    // end-to-end. Until then the adapters preflight-fail with operator-
    // readable messages — the orchestrator itself short-circuits the
    // rollback execution and reports the configuration gap.
    //
    // onRollbackSuccess marks any deferred verification for the rolled-back
    // proposal as `superseded` (PostExecutionVerifierService.supersedeForProposal)
    // so the lifecycle worker skips re-checking a system the operator
    // has already moved on from.
    const rollbackRegistry = new RollbackAdapterRegistry();
    rollbackRegistry.register(new NoOpRollbackAdapter());
    rollbackRegistry.register(new PostgresRollbackAdapter(pgPool));
    rollbackRegistry.register(new GitRollbackAdapter());
    rollbackRegistry.register(new SlackRollbackAdapter({
      resolve: async () => null,
    }));
    rollbackRegistry.register(new DeployRollbackAdapter({
      resolve: async () => null,
    }));
    rollbackRegistry.register(new GenericWebhookRollbackAdapter());

    const rollbackOrchestrator = new RollbackOrchestrator(pgPool, rollbackRegistry, {
      onRollbackSuccess: async ({ tenantId, proposalId }) => {
        await postExecVerifier.supersedeForProposal(tenantId, proposalId);
      },
    });
    void rollbackOrchestrator;  // wired into /api/v1/tenants/:id/actions/:id/rollback in F.4

    // T.0: outbox relay. Drains oweibo.outbox to Redis lifecycle channels
    // (oweibo.lifecycle.<subject>). Polls every 2s; fail-open on Redis errors.
    const outboxRelay = new OutboxRelay(pgPool, {
      publish: (channel, body) => rPub(channel, body),
    });
    outboxRelay.start();
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
    ...(multiPartyApproval && quotaService
      ? { multiPartyApproval, quotaService }
      : {}),
    // F.4.1: forensic + replay surface. Mounts iff the forensic pipeline
    // is wired (storage adapter + HMAC signer + HitlHandoffService).
    ...(hitlHandoff && forensicStorage
      ? { hitlHandoff, forensicStorage }
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
