"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TENANT_DOMAIN_BINDING_SOFT_CAP = void 0;
/**
 * Soft cap on bindings per tenant. Above this, `replaceBindings`
 * requires the `force` flag — the admin-web UI surfaces a confirmation
 * dialog rather than silently allowing a 10-domain tenant.
 */
exports.TENANT_DOMAIN_BINDING_SOFT_CAP = 3;
//# sourceMappingURL=ITenantDomainBinding.js.map