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
  /** Full URL to the JWKS endpoint, e.g. https://identity.oweibo.io/.well-known/jwks.json */
  jwksUri: string;
  issuer:  string;
  audience: string;
  /**
   * Non-empty allowlist of JWKS key IDs the verifier will accept. Tokens with
   * a `kid` outside this list are rejected BEFORE the JWKS endpoint is
   * consulted — defends against rogue-key injection if an attacker compromises
   * the IdP's JWKS publish path, and against JWKS-endpoint DoS via rotated-
   * attacker-kid floods. Required (factory throws on undefined or empty).
   */
  allowedKids: readonly string[];
  /**
   * Default false. When false, `jwksUri` must be https:// (loopback http is
   * always allowed for dev convenience). Set true ONLY for trusted internal
   * networks where TLS is terminated at a proxy. Factory throws otherwise.
   */
  allowInsecureJwksUri?: boolean;
}

export interface LegacyToken {
  hashedSecret: string;
  tenantId:     string;
  /** Scopes granted to this legacy token — defaults to tenant_developer set. */
  scopes:       string[];
}
