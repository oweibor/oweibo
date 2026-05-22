/**
 * T.0: Tenant lifecycle event contracts.
 *
 * Outbox events published when a tenant transitions through its lifecycle.
 * Every event ships with a `schemaVersion` so consumers can fork on payload
 * shape across non-breaking evolutions; new versions get new subjects
 * (`tenant.created.v2`) rather than reusing the v1 subject.
 *
 * Subject convention: `tenant.<lifecycle>.<vN>` — published to Redis channel
 * `oweibo.lifecycle.<subject>` by the OutboxRelay.
 */
export declare const TENANT_CREATED_V1_SUBJECT: "tenant.created.v1";
export interface TenantCreatedV1Payload {
    readonly schemaVersion: '1';
    readonly tenantId: string;
    readonly slug: string;
    readonly templateSlug: string;
    readonly createdBy: string | null;
    readonly createdAt: string;
}
/**
 * Type-safe envelope for any tenant lifecycle event. Future events
 * (tenant.suspended.v1, tenant.deleted.v1, tenant.template.changed.v1) extend
 * this discriminated union — consumers exhaustively switch on `subject`.
 */
export type TenantLifecycleEvent = {
    readonly subject: typeof TENANT_CREATED_V1_SUBJECT;
    readonly payload: TenantCreatedV1Payload;
};
//# sourceMappingURL=tenant.events.d.ts.map