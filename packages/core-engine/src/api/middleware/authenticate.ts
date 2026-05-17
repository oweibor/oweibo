/**
 * authenticate — JWT Bearer token authentication middleware (§5c.1).
 *
 * Validates JWT from Authorization header. Signing key loaded from Vault.
 * Attaches `userId` and `tenantId` (both required) to the request object.
 *
 * tenantId is REQUIRED in the JWT payload. Tokens without a tenantId claim
 * are rejected with 401 to prevent anonymous cross-tenant access.
 */
import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface AuthConfig {
  readonly jwtSecret: string;
  readonly issuer?: string;
}

interface JWTPayload {
  sub: string;
  /** Required — every token must be scoped to a tenant. */
  tenantId: string;
  iat: number;
  exp: number;
  iss?: string;
  /** Optional scope list (present on identity-service tokens). */
  scopes?: string[];
  /** ctx.tenantId form used by identity-service tokens. */
  ctx?: { tenantId?: string };
}

/** Augmented request type exposed to downstream handlers. */
export interface AuthenticatedRequest extends Request {
  userId: string;
  tenantId: string;
  scopes: string[];
}

export function createAuthMiddleware(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'missing_token',
        message: 'Authorization header with Bearer token required',
      });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = verifyJWT(token, config.jwtSecret);

      if (config.issuer && payload.iss !== config.issuer) {
        res.status(401).json({ error: 'invalid_issuer' });
        return;
      }

      if (payload.exp && payload.exp * 1000 < Date.now()) {
        res.status(401).json({ error: 'token_expired' });
        return;
      }

      // tenantId is mandatory — reject tokens that omit it entirely or supply blank
      if (!payload.tenantId || typeof payload.tenantId !== 'string') {
        res.status(401).json({
          error: 'missing_tenant',
          message: 'JWT must contain a non-empty tenantId claim',
        });
        return;
      }

      // Attach to request for downstream handlers
      const authedReq = req as unknown as AuthenticatedRequest;
      authedReq.userId   = payload.sub;
      authedReq.tenantId = payload.tenantId ?? payload.ctx?.tenantId ?? '';
      authedReq.scopes   = payload.scopes ?? [];
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}

function verifyJWT(token: string, secret: string): JWTPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  // parts.length === 3 is guaranteed by the check above; non-null assertions are safe.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const [headerB64, payloadB64, signatureB64] = [parts[0]!, parts[1]!, parts[2]!];
  const data = `${headerB64}.${payloadB64}`;

  const expectedSig = createHmac('sha256', secret)
    .update(data)
    .digest('base64url');

  // Constant-time comparison to defeat signature-timing oracles.
  // Length check first because timingSafeEqual throws on length mismatch;
  // an attacker controls signatureB64 so we must not let that exception
  // become the timing leak.
  const a = Buffer.from(expectedSig, 'utf8');
  const b = Buffer.from(signatureB64, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid signature');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  return payload as JWTPayload;
}
