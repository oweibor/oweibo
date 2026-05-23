/**
 * T.2.h: OrgGraphSeeder — installs the minimal day-one graph for a new
 * tenant.
 *
 * Seeds:
 *   1. a 'person' node bound to the creating user (if known)
 *   2. a 'team' node "Tenant Admins" with the creator as member_of
 *   3. a 'decision_body' node "Tenant Admin Council" with 'approves'
 *      edges typed for the always-require-approval action classes from
 *      T.−1 (financial.*, personnel.*, irreversible.*, deploy.prod,
 *      write.tenant_db.prod, write.local.repo_prod, comm.external_*,
 *      write.external_api.prod).
 *
 * Idempotent: re-seeding the same tenant is safe — node lookups by label
 * short-circuit and edge upserts have unique conflict targets.
 */
import type { OrgGraphService } from './OrgGraphService.js';
/** Default set of action classes the Tenant Admin Council approves. */
export declare const DEFAULT_COUNCIL_APPROVED_CLASSES: readonly string[];
export interface SeederInput {
    readonly tenantId: string;
    /** Creator user id; when null the person node is not created. */
    readonly creatorUserId: string | null;
    /** Optional override of the approved class set. */
    readonly approvedClasses?: readonly string[];
}
export interface SeederResult {
    readonly creatorNodeId: string | null;
    readonly adminTeamNodeId: string;
    readonly councilNodeId: string;
    readonly nodesCreated: number;
    readonly edgesCreated: number;
}
export declare class OrgGraphSeeder {
    private readonly service;
    constructor(service: OrgGraphService);
    seed(input: SeederInput): Promise<SeederResult>;
}
//# sourceMappingURL=OrgGraphSeeder.d.ts.map