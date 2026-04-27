/**
 * JWT mint and verify.
 *
 * Token shape per §4.2 of oweibo_enterprise_platform_v1.md:
 *   iss, aud, sub, ctx.tenantId, scopes[], trust, iat, exp, nbf, jti, kid
 *   act_as present only on agent tokens.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { getPrivateKey, getPublicKey } from './jwks.js';
import type { Principal } from '@oweibo/db';

export interface OweiboClaims extends JWTPayload {
  ctx:    { tenantId: string };
  scopes: string[];
  trust:  'supervised' | 'graduated' | 'autonomous';
  act_as?: { sub: string; tenantId: string };
}

export async function mintAccessToken(principal: Principal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: OweiboClaims = {
    iss:    config.JWT_ISSUER,
    aud:    config.JWT_AUDIENCE,
    sub:    principal.sub,
    ctx:    principal.ctx,
    scopes: principal.scopes,
    trust:  deriveTrustMode(principal.scopes),
    jti:    uuidv4(),
    iat:    now,
    nbf:    now,
    exp:    now + config.ACCESS_TOKEN_TTL,
  };
  if (principal.actAs) {
    payload.act_as = principal.actAs;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: config.JWT_KEY_ID })
    .sign(getPrivateKey());
}

export async function verifyAccessToken(token: string): Promise<OweiboClaims> {
  const { payload } = await jwtVerify<OweiboClaims>(token, getPublicKey(), {
    issuer:   config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    algorithms: ['RS256'],
  });
  return payload;
}

function deriveTrustMode(scopes: string[]): 'supervised' | 'graduated' | 'autonomous' {
  if (scopes.includes('trust:autonomous')) return 'autonomous';
  if (scopes.includes('trust:graduated'))  return 'graduated';
  return 'supervised';
}

/**
 * Mint an agent token — server-only, no public HTTP route.
 * Scopes are the intersection of parent task scopes and agent profile scopes.
 */
export async function mintAgentToken(opts: {
  taskId:     string;
  runId:      string;
  userId:     string;
  tenantId:   string;
  parentScopes: string[];
  agentScopes:  string[];
  taskBudgetRemainingMs: number;
}): Promise<string> {
  const ttlMs  = Math.min(opts.taskBudgetRemainingMs, 60 * 60 * 1000); // max 60 min
  const ttlSec = Math.max(Math.floor(ttlMs / 1000), 60);
  const now    = Math.floor(Date.now() / 1000);

  const scopes = opts.parentScopes.filter(s => opts.agentScopes.includes(s));

  const payload: OweiboClaims = {
    iss:    config.JWT_ISSUER,
    aud:    config.JWT_AUDIENCE,
    sub:    `agent:${opts.runId}`,
    ctx:    { tenantId: opts.tenantId },
    scopes,
    trust:  deriveTrustMode(scopes),
    act_as: { sub: opts.userId, tenantId: opts.tenantId },
    jti:    uuidv4(),
    iat:    now,
    nbf:    now,
    exp:    now + ttlSec,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: config.JWT_KEY_ID })
    .sign(getPrivateKey());
}
