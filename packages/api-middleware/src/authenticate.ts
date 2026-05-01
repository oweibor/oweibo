/**
 * authenticate middleware
 *
 * Resolves a Principal from one of three token forms:
 *   1. RS256 JWT in Authorization: Bearer header  — verified against JWKS
 *   2. oweibo_ak_* API key                        — DB lookup via @oweibo/db
 *   3. Legacy static token (oweibo_legacy_*)      — pre-configured hash map
 *
 * Populates req.principal on success; returns 401 on failure.
 *
 * Usage:
 *   app.use(authenticate(jwksConfig, legacyTokenMap))
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHash } from 'crypto';
import { prisma } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import type { Request, Response, NextFunction } from 'express';
import type { JwksConfig, LegacyToken } from './types.js';

interface OweiboClaims extends JWTPayload {
  ctx:    { tenantId: string };
  scopes: string[];
  trust:  string;
  act_as?: { sub: string; tenantId: string };
}

// JWKS set is cached per URI — jose re-fetches only when kid is unknown
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwksSet(uri: string) {
  if (!jwksSets.has(uri)) {
    jwksSets.set(uri, createRemoteJWKSet(new URL(uri), { cacheMaxAge: 600_000 }));
  }
  return jwksSets.get(uri)!;
}

export function authenticate(jwksCfg: JwksConfig, legacyMap: Map<string, LegacyToken> = new Map()) {
  return async function authenticateMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
      return;
    }
    const token = authHeader.slice(7);

    try {
      if (token.startsWith('oweibo_ak_')) {
        await resolveApiKey(token, req, next);
      } else if (token.startsWith('oweibo_legacy_')) {
        resolveLegacy(token, legacyMap, req, res, next);
      } else {
        await resolveJwt(token, jwksCfg, req, next);
      }
    } catch {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
    }
  };
}

async function resolveJwt(token: string, cfg: JwksConfig, req: Request, next: NextFunction) {
  const jwks = getJwksSet(cfg.jwksUri);
  const { payload } = await jwtVerify<OweiboClaims>(token, jwks, {
    issuer:     cfg.issuer,
    audience:   cfg.audience,
    algorithms: ['RS256'],
  });
  (req as any).principal = {
    sub:    payload.sub ?? '',
    kind:   payload.sub?.startsWith('agent:')  ? 'agent'
          : payload.sub?.startsWith('apikey:') ? 'api_key'
          : 'user',
    scopes: payload.scopes,
    ctx:    payload.ctx,
    actAs:  payload.act_as,
  } satisfies Principal;
  next();
}

async function resolveApiKey(token: string, req: Request, next: NextFunction) {
  const prefix = token.slice(0, 24);
  const hashed = createHash('sha256').update(token).digest('hex');
  const key    = await prisma.apiKey.findFirst({
    where: { prefix, hashedSecret: hashed, revokedAt: null },
  });
  if (!key || (key.expiresAt && key.expiresAt < new Date())) {
    throw new Error('invalid api key');
  }
  // Fire-and-forget last_used_at
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });

  (req as any).principal = {
    sub:    `apikey:${key.id}`,
    kind:   'api_key',
    scopes: key.scopes,
    ctx:    { tenantId: key.tenantId },
  } satisfies Principal;
  next();
}

function resolveLegacy(
  token: string,
  legacyMap: Map<string, LegacyToken>,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const hashed = createHash('sha256').update(token).digest('hex');
  const entry  = legacyMap.get(hashed);
  if (!entry) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    return;
  }
  (req as any).principal = {
    sub:    `apikey:legacy:${entry.tenantId}`,
    kind:   'api_key',
    scopes: entry.scopes,
    ctx:    { tenantId: entry.tenantId },
  } satisfies Principal;
  next();
}
