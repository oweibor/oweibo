import { Router } from 'express';
import type { RemoteSkillFetcher } from '../../general-coding/project/RemoteSkillFetcher.js';
export interface SkillsRouterDeps {
    /** When provided, POST /skills/pull delegates to this fetcher (v9.4.2). */
    readonly fetcher?: RemoteSkillFetcher;
    /** Absolute path to the tenant workspace root (required when fetcher is set). */
    readonly repoRoot?: string;
    /** Tenant id used for per-tenant Vault token lookup (required when fetcher is set). */
    readonly tenantId?: string;
}
export declare function createSkillsRouter(deps?: SkillsRouterDeps): Router;
export default createSkillsRouter;
//# sourceMappingURL=skills.routes.d.ts.map