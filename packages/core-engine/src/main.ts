// packages/core-engine/src/main.ts
// Full startup sequence — wires all services and starts the API server + channel gateway.
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
// Env is loaded by the launcher via Node's --env-file (see the root
// `dev:engine` / `start:engine` scripts). No runtime dotenv dependency.
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
import { RateLimitPolicyResolver }  from './action/RateLimitPolicy.js';
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
import { LineageRecorder }           from './action/LineageRecorder.js';
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
import { DomainRegistry }             from './domain/DomainRegistry.js';
import { TenantDomainBindingService } from './domain/TenantDomainBindingService.js';
import { PgComplianceEvaluationReader } from './domain/PgComplianceEvaluationReader.js';
import { ConnectorRegistry }           from './connector/ConnectorRegistry.js';
import { PgTenantConnectorService }    from './connector/PgTenantConnectorService.js';
import { TenantTemplateRegistry }      from './seed/TenantTemplateRegistry.js';
import { CalibrationService }        from './infrastructure/CalibrationService.js';
import { DomainIntakeService }       from './seed/DomainIntakeService.js';
import { DomainClassifier, type DomainOntologyEntry } from './seed/DomainClassifier.js';
import * as fsSync                   from 'node:fs';
import { TtvMetricsService }         from './observability/TtvMetricsService.js';
import { DomainCurrencyMonitor }     from './domain/DomainCurrencyMonitor.js';
import { DomainDepthMetrics }        from './domain/DomainDepthMetrics.js';
import { SmeFeedbackAggregator }     from './domain/SmeFeedbackAggregator.js';
import { SmeReviewService }          from './domain/SmeReviewService.js';
import { runWithAdvisoryLock }       from './infrastructure/runWithAdvisoryLock.js';
import { PartitionMaintenance }      from './infrastructure/PartitionMaintenance.js';
import {
  HmacSnapshotSigner,
  HmacSnapshotVerifier,
  loadHmacSnapshotKeys,
}                                    from './action/HmacSnapshotVerifier.js';
import { PromptRegistry }          from '@oweibo/prompt-registry';
import { PromptAssembler }         from '@oweibo/prompt-registry';
import { startServer }             from './api/server.js';
import { DocGeneratorPipeline }    from './doc-generator/DocGeneratorPipeline.js';
import { DocGeneratorQueue }       from './doc-generator/queue/DocGeneratorQueue.js';
import { DocGeneratorWorker }      from './doc-generator/queue/DocGeneratorWorker.js';
import { SessionReaper }           from './doc-generator/queue/SessionReaper.js';
import { RedisTaskEventBus }       from './infrastructure/eventbus/RedisTaskEventBus.js';
import { AuditLogger }             from './doc-generator/observability/AuditLogger.js';
import { createDocsRouter }        from './doc-generator/http/docsRouter.js';

async function main(): Promise<void> {
  // F.7.1: bootstrap OpenTelemetry SDK BEFORE any other module work so
  // every subsequent service operates inside the tracer's context. Opt-in
  // via OWEIBO_TRACING_ENABLED=true so dev/test runs aren't forced to
  // bind to the OTLP exporter port.
  if (process.env['OWEIBO_TRACING_ENABLED'] === 'true') {
    const { initOtel } = await import('@oweibo/observability');
    initOtel(process.env['OTEL_SERVICE_NAME'] ?? 'oweibo-api');
    console.log('[main] OpenTelemetry SDK initialised');
  }

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
  // Hoisted to function scope: these are constructed inside the DATABASE_URL
  // block below but referenced unconditionally at the startServer() call (the
  // route-mount spreads treat `undefined` as "route disabled"). Declaring them
  // with block scope inside the `if` made them out-of-scope at startServer —
  // a ReferenceError that @ts-nocheck hid and that stopped the API listening.
  let slaService: ApprovalSlaService | undefined;
  let rateLimitPolicyResolver: RateLimitPolicyResolver | undefined;
  let tenantDomainLookup: PgTenantDomainBindingLookup | undefined;
  let domainRegistry: DomainRegistry | undefined;
  let tenantDomainBindings: TenantDomainBindingService | undefined;
  let complianceEvaluations: PgComplianceEvaluationReader | undefined;
  let calibrationService: CalibrationService | undefined;
  let domainDepthMetrics: DomainDepthMetrics | undefined;
  let smeReviewService: SmeReviewService | undefined;
  let lineageRecorder: LineageRecorder | undefined;
  let connectorRegistry: ConnectorRegistry | undefined;
  let tenantConnectorService: PgTenantConnectorService | undefined;
  let tenantTemplateRegistry: TenantTemplateRegistry | undefined;
  let hitlHandoff: HitlHandoffService | undefined;
  let forensicStorage: import('@oweibo/core-contracts').IForensicPacketStorage | undefined;
  let rollbackOrchestrator: RollbackOrchestrator | undefined;
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
    slaService = new ApprovalSlaService(pgPool);
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
    // F.4.4: RateLimitPolicyResolver backs both the gate-side hot path
    // (via RateLimiter, which can resolve internally) and the admin
    // /actions/policies/ratelimit surface introduced here.
    rateLimitPolicyResolver = new RateLimitPolicyResolver(pgPool);
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
    tenantDomainLookup = new PgTenantDomainBindingLookup(pgPool);
    const compliancePackRegistry = new ComplianceRulePackRegistry(undefined, {
      tenantDomainLookup: (t) => tenantDomainLookup.forTenant(t),
    });
    const complianceRuleEvaluator = new ComplianceRuleEvaluator(compliancePackRegistry);
    // F.4.5: companion services for the /tenants/:tenantId/domains/* admin
    // surface. Registry is the canonical taxonomy (v1 bundled catalog);
    // bindingService writes tenant_domain_binding rows; evaluationsReader
    // surfaces compliance_rule_evaluations rows for the audit page.
    domainRegistry            = new DomainRegistry();
    tenantDomainBindings      = new TenantDomainBindingService(pgPool);
    complianceEvaluations     = new PgComplianceEvaluationReader(pgPool);

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
    calibrationService = new CalibrationService(pgPool, {
      ...(snapshotSigner ? { snapshotSigner } : {}),
    });
    // F.4.6: calibrationService now flows into createServer below for
    // /tenants/:tenantId/calibration. Task-create-path wiring is the
    // follow-up that F.3.1's scope deferred.

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
    domainDepthMetrics       = new DomainDepthMetrics(pgPool);
    const smeFeedbackAggregator    = new SmeFeedbackAggregator(pgPool);
    // F.3.4: SmeReviewService handles the per-queue-item review lifecycle
    // (enqueue → reviewers vote → aggregation via SmeFeedbackAggregator).
    // Constructed here so the F.4 /domains/sme-review admin routes can
    // take it via runtime composition.
    smeReviewService         = new SmeReviewService(pgPool);
    // domainDepthMetrics + smeReviewService now flow into createServer
    // for the F.4.5 /tenants/:tenantId/domains/* surface.
    void smeFeedbackAggregator;     // event-driven; no admin-web route consumes it directly

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

    // Daily partition-maintenance tick (000063): keeps audit_log +
    // action_lineage monthly partitions created ahead of rollover so the
    // 000062 DEFAULT partitions stay empty. Idempotent DDL behind a
    // SECURITY DEFINER function; the advisory lock only de-dupes replicas.
    const partitionCronExpr = process.env['PARTITION_MAINTENANCE_CRON'] ?? '30 2 * * *';  // daily 02:30 UTC
    if (partitionCronExpr.toLowerCase() === 'off' || partitionCronExpr === '') {
      console.log('[oweibo] PartitionMaintenance cron disabled (PARTITION_MAINTENANCE_CRON=off)');
    } else {
      const partitionMaintenance = new PartitionMaintenance(pgPool);
      const partitionTick = (): void => {
        void runWithAdvisoryLock(pgPool!, 'partition_maintenance_tick', async () => {
          const r = await partitionMaintenance.tick();
          console.log('[oweibo] PartitionMaintenance.tick():', {
            ensured: r.rows.length,
            created: r.created,
            skippedDefaultRows: r.skippedDefaultRows,
            skippedLockTimeout: r.skippedLockTimeout,
          });
        }).catch((err: unknown) => {
          console.error('[oweibo] PartitionMaintenance.tick() failed:',
            err instanceof Error ? err.message : String(err));
        });
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cron = require('node-cron') as { schedule(expr: string, fn: () => void): unknown };
      cron.schedule(partitionCronExpr, partitionTick);
      // Boot tick: a fixed-time daily cron never fires on a process that
      // isn't running at that time (dev machines, spot workers). Running
      // once at startup guarantees the window is ensured on every boot;
      // the advisory lock de-dupes replicas booting together.
      partitionTick();
      console.log(`[oweibo] PartitionMaintenance cron scheduled: ${partitionCronExpr} (+boot tick)`);
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

    // ── F.4.2: lineage recorder (read-side surfacing only at this point) ──
    // Write-side wiring is the responsibility of ActionTrustLadder + the
    // execution path; this construction supplies the read API the admin
    // surface needs in /tenants/:tenantId/lineage/*.
    lineageRecorder = new LineageRecorder(pgPool);

    // ── F.4.7: connectors + templates admin surfaces ──────────────────────
    // ConnectorRegistry loads the platform catalog from disk; degrades
    // to an empty registry when the directory is missing (the route
    // still mounts and surfaces 'unknown_connector' on install).
    try {
      connectorRegistry = await ConnectorRegistry.loadFromDirectory(
        ConnectorRegistry.defaultDirectory(),
      );
    } catch (err) {
      console.warn('[oweibo] connector catalog load failed; using empty registry:',
        err instanceof Error ? err.message : String(err));
      connectorRegistry = ConnectorRegistry.fromEntries([]);
    }
    // K.2 (arch §9.5): install-order enforcement — content connectors
    // refuse to install until an identity connector is active.
    tenantConnectorService = new PgTenantConnectorService(pgPool, {
      identityConnectorIds: ['google-workspace-idp'],
    });
    tenantTemplateRegistry = new TenantTemplateRegistry(pgPool);

    // ── F.2.3: forensic packet pipeline + HITL handoff ────────────────────
    //
    // Storage backend is selected via OWEIBO_FORENSIC_STORAGE_KIND
    // (filesystem|s3|none). When the kind resolves to none/undefined the
    // forensic features stay dormant — the HITL routes will surface
    // 'forensic_features_disabled' to operators. Signer requires
    // infra/forensic-signer in Vault (CALIBRATION_SIGNING_KEY equivalent
    // for packets); without it we skip construction with a startup warning.
    let forensicBuilder: ForensicPacketBuilder | undefined;
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

    rollbackOrchestrator = new RollbackOrchestrator(pgPool, rollbackRegistry, {
      onRollbackSuccess: async ({ tenantId, proposalId }) => {
        await postExecVerifier.supersedeForProposal(tenantId, proposalId);
      },
    });
    // F.4.3: rollbackOrchestrator now flows into createServer below.

    // T.0 + F.6: outbox relay. Drains oweibo.outbox to Redis lifecycle
    // channels (oweibo.lifecycle.<subject>). Polls every 2s; fail-open on
    // Redis errors. F.6 dual-write flags add XADD to Redis Streams on top
    // of the legacy pub/sub PUBLISH; see plan F.6 for the 3-deploy
    // rollout sequence.
    const outboxDualWriteEnabled = process.env['OUTBOX_DUAL_WRITE_ENABLED'] === 'true';
    const outboxStreamsOnlyEnabled = process.env['OUTBOX_STREAMS_ENABLED'] === 'true'
      && !outboxDualWriteEnabled;
    const outboxRelay = new OutboxRelay(pgPool, {
      publish: (channel, body) => rPub(channel, body),
      addToStream: (stream, body, opts) => {
        // ioredis XADD signature: xadd(key, [maxLen?], NOMKSTREAM?|empty, '*'|id, ...field-value pairs)
        // We pass a single field "payload" containing the JSON body and key the dedup on opts.eventId
        // which is embedded in `body` as well.
        const maxLen = opts?.maxLen;
        const args = maxLen !== undefined
          ? [stream, 'MAXLEN', '~', String(maxLen), '*', 'payload', body, 'eventId', opts?.eventId ?? '']
          : [stream, '*', 'payload', body, 'eventId', opts?.eventId ?? ''];
        return (redis.call('XADD', ...args) as Promise<unknown>).then(() => undefined as void);
      },
    }, {
      streamsDualWriteEnabled: outboxDualWriteEnabled,
      streamsOnlyEnabled: outboxStreamsOnlyEnabled,
    });
    outboxRelay.start();
    if (outboxDualWriteEnabled || outboxStreamsOnlyEnabled) {
      console.log(`[main] OutboxRelay: streams ${outboxStreamsOnlyEnabled ? 'ONLY' : 'DUAL-WRITE'} mode enabled`);
    }
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

  // ── DomainIntakeService (B.2 server side) ─────────────────────────────────
  // Constructs a DomainClassifier from an on-disk ontology when
  // OWEIBO_DOMAIN_ONTOLOGY_PATH is set. The route exposed by
  // createInternalRouter returns 503 when this is undefined.
  const domainIntakeService = buildDomainIntakeService(modelRouter);

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
  // startServer builds the app AND binds the port (createServer only builds
  // it). main.ts previously called createServer, so the API never listened.
  await startServer({
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
    // F.4.2: lineage read surface — recorder is always constructed.
    lineageRecorder,
    // F.4.3: rollback invocation + plan reads — orchestrator is always
    // constructed; without it the routes return 503 rollback_disabled.
    rollbackOrchestrator,
    // F.4.5: domain admin surface — registry, bindings, sme review,
    // depth metrics, compliance evaluations. All six are always
    // constructed; the server mounts the router only when all six are
    // present, so any future degradation is observable at boot.
    domainRegistry,
    tenantDomainBindings,
    tenantDomainBindingLookup: tenantDomainLookup,
    smeReviewService,
    domainDepthMetrics,
    complianceEvaluations,
    // F.4.6: calibration readiness snapshot — admin badge + onboarding.
    calibrationService,
    // F.4.4: tenant policy override surface. SLA, multiparty, ratelimit,
    // and quota services flow in. multiPartyApproval + quotaService are
    // already threaded above for the F.4.0 grants/quotas surface; the
    // SLA and rate-limit-policy resolvers are new here.
    approvalSlaService: slaService,
    rateLimitPolicyResolver,
    // F.4.7: connectors + templates admin surfaces.
    connectorRegistry,
    tenantConnectorService,
    tenantTemplateRegistry,
    // F.5.9 server: enables POST /api/v1/_internal/memories/seed when both
    // the token AND a memory orchestrator are available. The token is the
    // shared internal secret -- workers (tenant-bootstrap-worker) hold
    // the same value. When unset, the path stays 404 (HttpMemoryWriter
    // callers will fail fast rather than write to a broken endpoint).
    // B.1 + B.2 server side: when the internal token is set, also expose
    // the SkillRegistry (already constructed above) and a DomainIntakeService
    // for the worker's HTTP adapters. SkillRegistry is unconditionally
    // available; DomainIntakeService loads its ontology from
    // OWEIBO_DOMAIN_ONTOLOGY_PATH (a JSON array of DomainOntologyEntry).
    // When the path is unset OR the file fails to parse, the service is
    // not exposed -- the /domain/classify route then returns 503 and
    // the worker's HttpDomainClassifier fails fast.
    ...(process.env['OWEIBO_INTERNAL_API_TOKEN']
      ? {
          internalApiToken: process.env['OWEIBO_INTERNAL_API_TOKEN'],
          ...(memorySubsystem.orchestrator
            ? { memoryOrchestrator: memorySubsystem.orchestrator }
            : {}),
          skillRegistry,
          ...(domainIntakeService ? { domainIntakeService } : {}),
        }
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

/**
 * B.2 server-side helper. Reads OWEIBO_DOMAIN_ONTOLOGY_PATH and constructs
 * a DomainIntakeService over a DomainClassifier wired to ModelRouter's
 * embedding client. Returns `undefined` when:
 *   - The env var is unset.
 *   - The file is missing or malformed JSON.
 *   - The JSON does not parse to a non-empty DomainOntologyEntry[].
 *
 * In each failure case we log and return undefined; the server simply
 * does not expose POST /api/v1/_internal/domain/classify, and the worker
 * fail-fast on the resulting 503. We do NOT throw at startup so a misset
 * ontology file cannot crash the platform.
 */
function buildDomainIntakeService(modelRouter: ModelRouter): DomainIntakeService | undefined {
  const ontologyPath = process.env['OWEIBO_DOMAIN_ONTOLOGY_PATH'];
  if (!ontologyPath) return undefined;
  let raw: string;
  try {
    raw = fsSync.readFileSync(ontologyPath, 'utf-8');
  } catch (err) {
    console.warn(`[oweibo] OWEIBO_DOMAIN_ONTOLOGY_PATH (${ontologyPath}) unreadable; /domain/classify will return 503:`, err);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[oweibo] OWEIBO_DOMAIN_ONTOLOGY_PATH parse error; /domain/classify will return 503:`, err);
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.warn(`[oweibo] OWEIBO_DOMAIN_ONTOLOGY_PATH must contain a non-empty array; /domain/classify will return 503`);
    return undefined;
  }
  const ontology = parsed as readonly DomainOntologyEntry[];
  const embedClient = modelRouter.forEmbedding();
  const classifier = new DomainClassifier(ontology, (text: string) => embedClient.embed(text));
  return new DomainIntakeService(classifier);
}
