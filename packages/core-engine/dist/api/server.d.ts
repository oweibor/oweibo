import { createTasksRouter } from './routes/tasks.routes.js';
import { createHITLRouter } from './routes/hitl.routes.js';
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
export declare function createServer(deps: {
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
}, config?: Partial<ServerConfig>): Promise<{
    app: import('express').Application;
    port: number;
}>;
export declare function startServer(...args: Parameters<typeof createServer>): Promise<void>;
//# sourceMappingURL=server.d.ts.map