/**
 * server.ts — Express API server bootstrap (§5c.1, §18).
 *
 * Wires all routes, middleware, and DI. Starts the HTTP server
 * with OpenAPI docs at /api/v1/docs (swagger-ui-express).
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createLogger, format, transports } from 'winston';
import swaggerUi from 'swagger-ui-express';
import { createTasksRouter } from './routes/tasks.routes.js';
import { createHITLRouter } from './routes/hitl.routes.js';
import { createSkillsRouter } from './routes/skills.routes.js';
import { createPlatformRouter } from './routes/platform.routes.js';
import { createActionsRouter } from './routes/actions.routes.js';
import { createActionsExtendedRouter } from './routes/actionsExtended.routes.js';
import { createForensicsRouter } from './routes/forensics.routes.js';
import { createLineageRouter } from './routes/lineage.routes.js';
import { createTenantActionsRouter } from './routes/tenantActions.routes.js';
import { createDomainsRouter } from './routes/domains.routes.js';
import { createCalibrationRouter } from './routes/calibration.routes.js';
import { createPoliciesRouter } from './routes/policies.routes.js';
import { createConnectorsRouter } from './routes/connectors.routes.js';
import { createTemplatesRouter } from './routes/templates.routes.js';
import { createFabricRouter } from './routes/fabric.routes.js';
import { createInternalRouter } from './routes/internal.routes.js';
import { createAuthMiddleware } from './middleware/authenticate.js';
import { requireScopes } from './middleware/authorize.js';
import { openapiSpec } from './openapi.js';
import type { SecretsManager } from '../secrets/SecretsManager.js';
import type { Pool } from 'pg';
import type { OperationalModeService } from '../infrastructure/OperationalModeService.js';
import type { PromotionGateService } from '../bandit/PromotionGateService.js';
import type { MutationGovernanceService } from '../governance/MutationGovernanceService.js';
import type { CohortAdminService } from '../infrastructure/CohortAdminService.js';
import type { GepaInspectorService } from '../bandit/GepaInspectorService.js';
import type { PrivacyAuditService } from '../distillation/PrivacyAuditService.js';
import type { ActionTrustLadder } from '../action/ActionTrustLadder.js';
import type { DryRunRegistry } from '../action/DryRunRegistry.js';
import type { ShadowExecutor } from '../action/ShadowExecutor.js';

export interface ServerConfig {
  readonly port: number;
  readonly corsOrigins: string[];
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
}

const DEFAULT_CONFIG: ServerConfig = {
  port: 3100,
  corsOrigins: ['http://localhost:3000'],
  rateLimitWindowMs: 15 * 60_000,
  rateLimitMax: 100,
};

const log = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

/** Minimal in-memory rate limiter — no external dependency required. */
function createRateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.status(429).json({ error: 'rate_limit_exceeded', retryAfter });
      return;
    }
    entry.count++;
    next();
  };
}

export async function createServer(
  deps: {
    secrets: SecretsManager;
    intentPipeline: Parameters<typeof createTasksRouter>[0]['intentPipeline'];
    taskEventBus: Parameters<typeof createTasksRouter>[0]['taskEventBus'];
    interventionGateway: Parameters<typeof createTasksRouter>[0]['interventionGateway'];
    hitlGateway: Parameters<typeof createHITLRouter>[0]['hitlGateway'];
    taskStore?: Parameters<typeof createTasksRouter>[0]['taskStore'];
    /** Optional — when provided, mounts /api/v1/platform routes. */
    pool?: Pool;
    operationalMode?: OperationalModeService;
    /** Optional — when provided, enables /api/v1/platform/promotions/* (D.6). */
    promotionGate?: PromotionGateService;
    /** Optional — when provided, enables /api/v1/platform/prompts/mutations/* (D.12). */
    mutationGovernance?: MutationGovernanceService;
    /** Optional — when provided, enables /api/v1/platform/cohorts/* (D.1). */
    cohortAdmin?: CohortAdminService;
    /** Optional — when provided, enables /api/v1/platform/prompts/* (C.8). */
    gepaInspector?: GepaInspectorService;
    /** Optional — when provided, enables /api/v1/platform/privacy/audit (B.7). */
    privacyAudit?: PrivacyAuditService;
    /** T.−1: when all three are provided, enables /api/v1/actions/* routes. */
    actionTrustLadder?: ActionTrustLadder;
    dryRunRegistry?: DryRunRegistry;
    shadowExecutor?: ShadowExecutor;
    /** S.4 / S.6: enables /api/v1/actions/{grants,approvals,quotas}/* routes. */
    multiPartyApproval?: import('../action/MultiPartyApprovalService.js').MultiPartyApprovalService;
    quotaService?: import('../action/QuotaService.js').QuotaService;
    /** F.4.1: enables /api/v1/tenants/:tenantId/forensics/* routes. */
    hitlHandoff?: import('../action/HitlHandoffService.js').HitlHandoffService;
    forensicStorage?: import('@oweibo/core-contracts').IForensicPacketStorage;
    actionReplay?: import('../action/ActionReplayService.js').ActionReplayService;
    /** F.4.2: enables /api/v1/tenants/:tenantId/lineage/* routes. */
    lineageRecorder?: import('../action/LineageRecorder.js').LineageRecorder;
    /** F.4.3: enables rollback + plan-level reads at /tenants/:tenantId/actions. */
    rollbackOrchestrator?: import('../action/RollbackOrchestrator.js').RollbackOrchestrator;
    /** F.4.5: enables /api/v1/tenants/:tenantId/domains/* routes. */
    domainRegistry?: import('../domain/DomainRegistry.js').DomainRegistry;
    tenantDomainBindings?: import('../domain/TenantDomainBindingService.js').TenantDomainBindingService;
    tenantDomainBindingLookup?: import('../domain/PgTenantDomainBindingLookup.js').PgTenantDomainBindingLookup;
    smeReviewService?: import('../domain/SmeReviewService.js').SmeReviewService;
    domainDepthMetrics?: import('../domain/DomainDepthMetrics.js').DomainDepthMetrics;
    complianceEvaluations?: import('../domain/PgComplianceEvaluationReader.js').PgComplianceEvaluationReader;
    /** F.4.6: enables GET /api/v1/tenants/:tenantId/calibration. */
    calibrationService?: import('../infrastructure/CalibrationService.js').CalibrationService;
    /** F.4.4: enables /api/v1/tenants/:tenantId/actions/policies/* routes. */
    approvalSlaService?: import('../action/ApprovalSlaService.js').ApprovalSlaService;
    rateLimitPolicyResolver?: import('../action/RateLimitPolicy.js').RateLimitPolicyResolver;
    /** F.4.7: enables /api/v1/tenants/:tenantId/connectors/* + /templates/* routes. */
    connectorRegistry?: import('../connector/ConnectorRegistry.js').ConnectorRegistry;
    tenantConnectorService?: import('../connector/PgTenantConnectorService.js').PgTenantConnectorService;
    tenantTemplateRegistry?: import('../seed/TenantTemplateRegistry.js').TenantTemplateRegistry;
    /** F.5.9 server side: enables POST /api/v1/_internal/memories/seed for the
     *  HttpMemoryWriter caller. When the token + orchestrator are absent the
     *  route stays unmounted so the path returns 404. */
    internalApiToken?: string;
    memoryOrchestrator?: import('@oweibo/core-contracts').IMemoryOrchestrator;
    /** B.1 server side: enables POST /api/v1/_internal/skills/seed for the
     *  HttpSkillSeeder caller. Worker calls this so it doesn't need to bundle
     *  ModelRouter+Qdrant+Redis+Vault. */
    skillRegistry?: import('./routes/internal.routes.js').ISkillRegistryFacade;
    /** B.2 server side: enables POST /api/v1/_internal/domain/classify for the
     *  HttpDomainClassifier caller. Worker keeps its Postgres state machine
     *  local and outsources only the classification step. */
    domainIntakeService?: import('../seed/DomainIntakeService.js').DomainIntakeService;
    /** K.9: enables /api/v1/tenants/:tenantId/fabric/* (policy governance +
     *  connector rollout). Both services are required — the router serves
     *  both planes. */
    tenantPolicyService?: import('../fabric/policy/TenantPolicyService.js').TenantPolicyService;
    connectorUpgradeService?: import('../fabric/upgrade/ConnectorUpgradeService.js').ConnectorUpgradeService;
    /** ADR-006 §3.4: relaxation ballots through the multi-party vote ledger.
     *  Optional — without it the fabric routes stay fail-closed on relaxations. */
    policyRelaxationFlow?: import('../fabric/policy/PolicyRelaxationFlow.js').PolicyRelaxationFlow;
  },
  config: Partial<ServerConfig> = {},
): Promise<{ app: import('express').Application; port: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors({ origin: cfg.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  // Health check (unauthenticated)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // OpenAPI docs (unauthenticated) — served at /api/v1/docs
  app.use(
    '/api/v1/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec as Parameters<typeof swaggerUi.setup>[0], {
      customSiteTitle: 'oweibo API Docs',
    }),
  );

  // Auth + rate limiting for all API routes.
  // Tokens are RS256, minted by apps/identity and verified against its JWKS
  // endpoint (no shared secret). Config is read from the same env vars the
  // identity service uses so issuer/audience/kid line up.
  const identityUrl = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  const auth = createAuthMiddleware({
    jwksUri:     process.env['JWKS_URI'] ?? `${identityUrl}/.well-known/jwks.json`,
    issuer:      process.env['JWT_ISSUER']   ?? 'https://identity.oweibo.io',
    audience:    process.env['JWT_AUDIENCE'] ?? 'oweibo-api',
    allowedKids: [process.env['JWT_KEY_ID'] ?? 'oweibo-rs256-v1'],
  });
  const rateLimiter = createRateLimiter(cfg.rateLimitWindowMs, cfg.rateLimitMax);

  // API v1 routes
  const v1 = express.Router();
  v1.use(rateLimiter);
  v1.use(auth);
  v1.use('/tasks', requireScopes({ read: ['tasks:read'], write: ['tasks:write'] }), createTasksRouter({
    intentPipeline: deps.intentPipeline,
    taskEventBus: deps.taskEventBus,
    interventionGateway: deps.interventionGateway,
    taskStore: deps.taskStore,
  }));
  v1.use('/hitl', requireScopes({ read: ['hitl:read'], write: ['hitl:decide'] }), createHITLRouter({ hitlGateway: deps.hitlGateway }));
  v1.use('/skills', requireScopes({ read: ['tasks:read'], write: ['tasks:write'] }), createSkillsRouter());

  // T.−1: action trust ladder routes. Mounted independently of the platform
  // routes — the gate is a tenant-scoped service, not a platform-admin one.
  if (deps.actionTrustLadder && deps.dryRunRegistry && deps.shadowExecutor) {
    v1.use('/actions', requireScopes({ read: ['tasks:read'], write: ['tasks:write'] }), createActionsRouter({
      trustLadder: deps.actionTrustLadder,
      registry: deps.dryRunRegistry,
      shadowExecutor: deps.shadowExecutor,
    }));
  }

  // F.4.0 (was S.4 / S.6): extended action routes (grants, approvals/votes,
  // quotas). Mounted under `/tenants/:tenantId/actions/*` — the URL param
  // is the source of truth, cross-checked against the JWT tenant claim by
  // the router's own `requireTenantParamMatchesJwt` guard. Previous mount
  // was `/actions/*` (round-5 audit) — moved here so the admin-web pages
  // hit a single tenant-scoped base.
  if (deps.multiPartyApproval && deps.quotaService) {
    v1.use('/tenants/:tenantId/actions', requireScopes({ read: ['hitl:read', 'tenant:settings:read'], write: ['hitl:decide', 'tenant:settings:write'] }), createActionsExtendedRouter({
      multiPartyApproval: deps.multiPartyApproval,
      quotaService: deps.quotaService,
    }));
  }

  // F.4.3: rollback invocation + plan-level proposal reads. Stacks at the
  // same /tenants/:tenantId/actions mount as actionsExtended — Express
  // walks routers in registration order, so non-overlapping verb/paths
  // coexist cleanly. Registry alone enables the plan reads; rollback
  // endpoints additionally require RollbackOrchestrator (else 503).
  if (deps.dryRunRegistry) {
    v1.use('/tenants/:tenantId/actions', requireScopes({ read: ['hitl:read', 'tenant:settings:read'], write: ['hitl:decide', 'tenant:settings:write'] }), createTenantActionsRouter({
      registry: deps.dryRunRegistry,
      ...(deps.rollbackOrchestrator ? { rollbackOrchestrator: deps.rollbackOrchestrator } : {}),
    }));
  }

  // F.4.1: forensic packet + replay routes. Requires the HITL service and
  // a storage adapter; replay endpoints additionally require ActionReplayService
  // (otherwise they return 503 replay_disabled). When forensics are dormant
  // (FORENSIC_REPLAY_ENABLED=false or no storage configured) the routes do
  // not mount at all — the admin pages surface a load error.
  if (deps.hitlHandoff && deps.forensicStorage) {
    v1.use('/tenants/:tenantId/forensics', requireScopes({ read: ['tenant:audit:read'], write: ['hitl:decide'] }), createForensicsRouter({
      hitlHandoff:    deps.hitlHandoff,
      storage:        deps.forensicStorage,
      ...(deps.actionReplay ? { actionReplay: deps.actionReplay } : {}),
    }));
  }

  // F.4.2: lineage routes (read-side admin surface).
  if (deps.lineageRecorder) {
    v1.use('/tenants/:tenantId/lineage', requireScopes({ read: ['tenant:audit:read'], write: ['tenant:audit:read'] }), createLineageRouter({
      lineage: deps.lineageRecorder,
    }));
  }

  // F.4.5: domain admin surface. Needs the full set of services so the
  // 8 endpoints behind the mount can resolve. When any are missing the
  // mount is skipped entirely — partial wiring would yield half-working
  // routes that crash on demand.
  if (
    deps.domainRegistry && deps.tenantDomainBindings && deps.tenantDomainBindingLookup
    && deps.smeReviewService && deps.domainDepthMetrics && deps.complianceEvaluations
  ) {
    v1.use('/tenants/:tenantId/domains', requireScopes({ read: ['tenant:settings:read'], write: ['tenant:settings:write'] }), createDomainsRouter({
      registry:        deps.domainRegistry,
      bindingService:  deps.tenantDomainBindings,
      bindingLookup:   deps.tenantDomainBindingLookup,
      smeReview:       deps.smeReviewService,
      depthMetrics:    deps.domainDepthMetrics,
      evaluations:     deps.complianceEvaluations,
    }));
  }

  // F.4.6: calibration snapshot — admin badge consumer.
  if (deps.calibrationService) {
    v1.use('/tenants/:tenantId/calibration', requireScopes({ read: ['tenant:settings:read'], write: ['tenant:settings:write'] }), createCalibrationRouter({
      calibration: deps.calibrationService,
    }));
  }

  // F.4.4: per-tenant policy override surface. All four services are
  // required because the router dispatches by URL `:domain` segment.
  // Partial wiring would yield half-working routes that fail on demand;
  // we mount only when every dependency is present.
  if (
    deps.approvalSlaService && deps.multiPartyApproval
    && deps.rateLimitPolicyResolver && deps.quotaService
  ) {
    v1.use('/tenants/:tenantId/actions/policies', requireScopes({ read: ['tenant:settings:read'], write: ['tenant:settings:write'] }), createPoliciesRouter({
      sla:        deps.approvalSlaService,
      multiparty: deps.multiPartyApproval,
      ratelimit:  deps.rateLimitPolicyResolver,
      quota:      deps.quotaService,
    }));
  }

  // F.4.7: connectors admin surface. Requires catalog + per-tenant
  // service. Optional binding lookup narrows recommendations by domain.
  if (deps.connectorRegistry && deps.tenantConnectorService) {
    v1.use('/tenants/:tenantId/connectors', requireScopes({ read: ['tenant:settings:read'], write: ['tenant:settings:write'] }), createConnectorsRouter({
      catalog:          deps.connectorRegistry,
      tenantConnectors: deps.tenantConnectorService,
      ...(deps.tenantDomainBindingLookup
        ? { bindingLookup: deps.tenantDomainBindingLookup }
        : {}),
    }));
  }

  // K.9: connector-fabric governance surface (tenant policy + rollouts).
  if (deps.tenantPolicyService && deps.connectorUpgradeService) {
    v1.use('/tenants/:tenantId/fabric', requireScopes({ read: ['tenant:settings:read'], write: ['tenant:settings:write'] }), createFabricRouter({
      policy:  deps.tenantPolicyService,
      upgrade: deps.connectorUpgradeService,
      ...(deps.policyRelaxationFlow ? { relaxations: deps.policyRelaxationFlow } : {}),
    }));
  }

  // F.4.7: tenant template catalog read surface.
  if (deps.tenantTemplateRegistry) {
    v1.use('/tenants/:tenantId/templates', requireScopes({ read: ['tenant:settings:read'], write: ['tenant:settings:write'] }), createTemplatesRouter({
      templates: deps.tenantTemplateRegistry,
    }));
  }

  if (deps.pool && deps.operationalMode) {
    v1.use('/platform', requireScopes({ read: ['platform:tenants:read'], write: ['platform:config:write'] }), createPlatformRouter({
      pool:            deps.pool,
      operationalMode: deps.operationalMode,
      ...(deps.promotionGate      ? { promotionGate:      deps.promotionGate }      : {}),
      ...(deps.mutationGovernance ? { mutationGovernance: deps.mutationGovernance } : {}),
      ...(deps.cohortAdmin        ? { cohortAdmin:        deps.cohortAdmin }        : {}),
      ...(deps.gepaInspector      ? { gepaInspector:      deps.gepaInspector }      : {}),
      ...(deps.privacyAudit       ? { privacyAudit:       deps.privacyAudit }       : {}),
    }));
  }

  // F.5.9 + B.1 + B.2 server: mount the _internal/* routes BEFORE the main
  // v1 router so they bypass the JWT auth middleware (they use their own
  // Bearer token comparison against OWEIBO_INTERNAL_API_TOKEN). Mounted
  // when the token is set AND at least one route-backing dep is present;
  // each individual route returns 503 unconfigured when its own dep is
  // missing -- so partial wiring (e.g. memories yes, skills no) is
  // explicit rather than a 404 surprise.
  if (deps.internalApiToken
      && (deps.memoryOrchestrator || deps.skillRegistry || deps.domainIntakeService)) {
    app.use(
      '/api/v1/_internal',
      express.json({ limit: '4mb' }), // larger ceiling than v1 to fit batched seed payloads
      createInternalRouter({
        internalToken: deps.internalApiToken,
        ...(deps.memoryOrchestrator  ? { memoryOrchestrator:  deps.memoryOrchestrator }  : {}),
        ...(deps.skillRegistry       ? { skillRegistry:       deps.skillRegistry }       : {}),
        ...(deps.domainIntakeService ? { domainIntakeService: deps.domainIntakeService } : {}),
      }),
    );
  }

  app.use('/api/v1', v1);

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('Unhandled API error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal_error', message: 'An internal error occurred' });
  });

  return { app, port: cfg.port };
}

export async function startServer(
  ...args: Parameters<typeof createServer>
): Promise<void> {
  const { app, port } = await createServer(...args);
  app.listen(port, () => {
    log.info('API server started', { port });
    log.info(`Health: http://localhost:${port}/health`);
    log.info(`API:    http://localhost:${port}/api/v1/`);
    log.info(`Docs:   http://localhost:${port}/api/v1/docs`);
  });
}
