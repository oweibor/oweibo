/**
 * tenantParam — guard for `/tenants/:tenantId/*` routes.
 *
 * F.4.0 mounted the tenant-scoped surface under a URL param. The router
 * itself is mounted with `mergeParams: true` so each handler can read
 * `req.params.tenantId`. This middleware:
 *
 *   1. Ensures the URL param is present (defence in depth — the route
 *      regex already requires it).
 *   2. Cross-checks the URL param against the JWT's tenantId claim;
 *      mismatch returns 403 `tenant_mismatch`. A token issued for
 *      tenant A must not be usable against tenant B's surface even if
 *      the operator pastes the wrong URL.
 *   3. Rewrites `req.tenantId` to the URL value. They will already be
 *      equal after the cross-check; rewriting just makes downstream
 *      handlers source-of-truth-consistent (the URL is the contract).
 *
 * Authn middleware (`createAuthMiddleware`) MUST run before this — the
 * cross-check assumes `req.tenantId` is already set from the JWT.
 */
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from './authenticate.js';

export function requireTenantParamMatchesJwt(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const urlTenantId = req.params['tenantId'];
  if (!urlTenantId || typeof urlTenantId !== 'string') {
    res.status(400).json({
      error: 'missing_tenant_param',
      message: 'URL must include :tenantId segment',
    });
    return;
  }
  if (req.tenantId !== urlTenantId) {
    res.status(403).json({
      error: 'tenant_mismatch',
      message: 'JWT tenantId does not match URL tenantId',
    });
    return;
  }
  req.tenantId = urlTenantId;
  next();
}
