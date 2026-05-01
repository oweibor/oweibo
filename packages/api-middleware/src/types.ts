import type { Request, Response, NextFunction } from 'express';
import type { Principal } from '@oweibo/db';

export type { Principal };

export interface AuthenticatedRequest extends Request {
  principal: Principal;
  requestId: string;
  /** W3C traceparent header forwarded from the client, or generated here. */
  traceparent?: string;
}

export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

export interface JwksConfig {
  /** Full URL to the JWKS endpoint, e.g. http://identity:3110/.well-known/jwks.json */
  jwksUri: string;
  issuer:  string;
  audience: string;
}

export interface LegacyToken {
  hashedSecret: string;
  tenantId:     string;
  /** Scopes granted to this legacy token — defaults to tenant_developer set. */
  scopes:       string[];
}
