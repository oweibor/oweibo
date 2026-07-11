/**
 * authenticate — RS256 JWT Bearer authentication, verified against the
 * identity service's JWKS (§ identity/authorization).
 *
 * The identity service (apps/identity) mints RS256 tokens signed with a
 * private key whose public half is published at /.well-known/jwks.json. This
 * middleware fetches that JWKS (cached, refreshed on unknown `kid` or TTL),
 * selects the key by `kid`, and verifies the RSASSA-PKCS1-v1_5/SHA-256
 * signature plus `iss` / `aud` / `exp`. It reads the tenant from the
 * identity-token `ctx.tenantId` claim (top-level `tenantId` is also accepted).
 *
 * Output shape is unchanged from the previous verifier — `req.userId`,
 * `req.tenantId`, `req.scopes` — so downstream routes need no edits.
 *
 * Verification uses node:crypto (JWK import) + global fetch; no jose or
 * @oweibo dependency is pulled into core-engine.
 *
 * Note: unlike the previous verifier, an empty tenant claim is NOT rejected
 * here. Authentication only proves who the caller is; whether a caller with no
 * bound tenant may touch a tenant-scoped resource is an authorization concern
 * enforced per-route (platform tokens legitimately carry an empty tenant).
 */
import type { Request, Response, NextFunction } from 'express';
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'crypto';

export interface AuthConfig {
  /** Full JWKS URL, e.g. http://localhost:3110/.well-known/jwks.json */
  readonly jwksUri: string;
  readonly issuer: string;
  readonly audience: string;
  /** Non-empty allowlist of accepted key IDs (defends against rogue kids). */
  readonly allowedKids: readonly string[];
  /** Allow http:// JWKS on non-loopback hosts (default false). */
  readonly allowInsecureJwksUri?: boolean;
}

interface JWTPayload {
  sub: string;
  ctx?: { tenantId?: string };
  tenantId?: string;
  scopes?: string[];
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

/** Augmented request type exposed to downstream handlers. */
export interface AuthenticatedRequest extends Request {
  userId: string;
  tenantId: string;
  scopes: string[];
}

const JWKS_TTL_MS = 600_000; // 10 min — matches identity's Cache-Control

interface JwksCache {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}
const jwksCaches = new Map<string, JwksCache>();

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

async function getVerificationKey(cfg: AuthConfig, kid: string): Promise<KeyObject> {
  const cached = jwksCaches.get(cfg.jwksUri);
  const fresh = cached && Date.now() - cached.fetchedAt <= JWKS_TTL_MS;
  if (fresh && cached.keys.has(kid)) {
    return cached.keys.get(kid)!;
  }

  const res = await fetch(cfg.jwksUri);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    const jwkKid = jwk['kid'];
    if (typeof jwkKid !== 'string') continue;
    try {
      // `JsonWebKey` isn't in this package's TS lib; cast the (structurally
      // correct) jwk input to createPublicKey's own parameter type.
      const jwkInput = { key: jwk, format: 'jwk' as const } as unknown as Parameters<typeof createPublicKey>[0];
      keys.set(jwkKid, createPublicKey(jwkInput));
    } catch {
      /* skip malformed key */
    }
  }
  jwksCaches.set(cfg.jwksUri, { keys, fetchedAt: Date.now() });

  const key = keys.get(kid);
  if (!key) throw new Error(`no JWKS key for kid ${kid}`);
  return key;
}

async function verifyJwt(token: string, cfg: AuthConfig): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(b64urlToBuf(headerB64).toString('utf-8')) as { alg?: string; kid?: string };
  // Pre-verify gate: reject on alg confusion / missing / non-allowlisted kid
  // BEFORE any JWKS fetch.
  if (header.alg !== 'RS256') throw new Error(`unsupported alg ${String(header.alg)}`);
  if (!header.kid) throw new Error('missing kid');
  if (!cfg.allowedKids.includes(header.kid)) throw new Error(`kid ${header.kid} not allowed`);

  const key = await getVerificationKey(cfg, header.kid);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const ok = cryptoVerify('RSA-SHA256', signingInput, key, b64urlToBuf(signatureB64));
  if (!ok) throw new Error('invalid signature');

  const payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf-8')) as JWTPayload;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) throw new Error('token expired');
  if (cfg.issuer && payload.iss !== cfg.issuer) throw new Error('invalid issuer');
  if (cfg.audience) {
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(cfg.audience) : aud === cfg.audience;
    if (!audOk) throw new Error('invalid audience');
  }
  return payload;
}

export function createAuthMiddleware(config: AuthConfig) {
  if (!config.allowedKids || config.allowedKids.length === 0) {
    throw new Error('createAuthMiddleware: allowedKids must be a non-empty array');
  }
  const url = new URL(config.jwksUri);
  if (url.protocol !== 'https:' && !isLoopback(url.hostname) && !config.allowInsecureJwksUri) {
    throw new Error(
      `createAuthMiddleware: refusing to fetch JWKS over insecure transport (${config.jwksUri}); ` +
      'set allowInsecureJwksUri:true only behind a TLS-terminating proxy',
    );
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'missing_token',
        message: 'Authorization header with Bearer token required',
      });
      return;
    }

    try {
      const payload = await verifyJwt(authHeader.slice(7), config);
      const authedReq = req as unknown as AuthenticatedRequest;
      authedReq.userId   = payload.sub;
      authedReq.tenantId = payload.ctx?.tenantId ?? payload.tenantId ?? '';
      authedReq.scopes   = payload.scopes ?? [];
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}
