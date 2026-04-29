/**
 * Authorization middleware
 *
 * requireScopes  — checks scopes on req.principal; 403 with missing list
 * requireTenantMatch — cross-tenant IDOR guard; platform_admin bypasses
 */
import type { Request, Response, NextFunction } from 'express';

export function requireScopes(...needed: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = (req as any).principal;
    if (!principal) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const missing = needed.filter((s) => !(principal.scopes as string[]).includes(s));
    if (missing.length > 0) {
      res.status(403).json({ error: 'insufficient_scope', missing });
      return;
    }
    next();
  };
}

/**
 * requireTenantMatch(paramName)
 *
 * Verifies that req.params[paramName] matches principal.ctx.tenantId.
 * Platform admins (platform:tenants:write scope) bypass this check.
 *
 * Returns 404 (not 403) on mismatch — leaking the existence of another
 * tenant's resource is itself an information disclosure.
 */
export function requireTenantMatch(paramName = 'tenantId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = (req as any).principal;
    if (!principal) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Platform admins may cross tenant boundaries
    if ((principal.scopes as string[]).includes('platform:tenants:write')) {
      next();
      return;
    }
    const urlTenantId = req.params[paramName];
    if (!urlTenantId || urlTenantId !== principal.ctx.tenantId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    next();
  };
}
