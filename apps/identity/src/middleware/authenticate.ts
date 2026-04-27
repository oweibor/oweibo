/**
 * Authenticate middleware for the identity service itself.
 * Downstream gateways have their own copy in packages/api-middleware (Phase 2).
 *
 * Accepts:
 *   1. BetterAuth session cookie (web UI)
 *   2. RS256 access JWT in Authorization: Bearer header
 *   3. API key in Authorization: Bearer header (oweibo_ak_ prefix)
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/jwt.js';
import { withTenantContext, prisma } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import { expandRoles } from '../policy.js';
import { createHash } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    return;
  }
  const token = authHeader.slice(7);

  try {
    if (token.startsWith('oweibo_ak_')) {
      await resolveApiKey(token, req, res, next);
    } else {
      await resolveJwt(token, req, res, next);
    }
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
  }
}

async function resolveJwt(token: string, req: Request, res: Response, next: NextFunction): Promise<void> {
  const claims = await verifyAccessToken(token);
  req.principal = {
    sub:    claims.sub ?? '',
    kind:   claims.sub?.startsWith('agent:') ? 'agent' : claims.sub?.startsWith('apikey:') ? 'api_key' : 'user',
    scopes: claims.scopes,
    ctx:    claims.ctx,
    actAs:  claims.act_as,
  };
  next();
}

async function resolveApiKey(token: string, req: Request, _res: Response, next: NextFunction): Promise<void> {
  const prefix = token.slice(0, 16); // oweibo_ak_xxxxxx
  const hashed = createHash('sha256').update(token).digest('hex');

  const key = await prisma.apiKey.findFirst({
    where: { prefix, hashedSecret: hashed, revokedAt: null },
  });

  if (!key || (key.expiresAt && key.expiresAt < new Date())) {
    throw new Error('invalid api key');
  }

  // Fire-and-forget last_used_at update
  prisma.apiKey.update({
    where: { id: key.id },
    data:  { lastUsedAt: new Date() },
  }).catch(() => undefined);

  req.principal = {
    sub:    `apikey:${key.id}`,
    kind:   'api_key',
    scopes: key.scopes,
    ctx:    { tenantId: key.tenantId },
  };
  next();
}

export function requireScopes(...needed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const missing = needed.filter(s => !principal.scopes.includes(s));
    if (missing.length > 0) {
      res.status(403).json({ error: 'insufficient_scope', missing });
      return;
    }
    next();
  };
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal?.scopes.includes('platform:tenants:write')) {
    res.status(403).json({ error: 'platform_admin_required' });
    return;
  }
  next();
}

export { withTenantContext, expandRoles };
