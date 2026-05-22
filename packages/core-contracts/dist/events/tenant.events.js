"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TENANT_CREATED_V1_SUBJECT = void 0;
exports.TENANT_CREATED_V1_SUBJECT = 'tenant.created.v1';
//# sourceMappingURL=tenant.events.js.map