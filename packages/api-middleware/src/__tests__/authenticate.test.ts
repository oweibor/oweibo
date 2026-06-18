/**
 * authenticate() — JWKS hardening tests.
 *
 * These tests do not spin up a real JWKS server. They cover the failure
 * modes that fire BEFORE the JWKS is consulted (factory validation +
 * pre-verify kid/alg checks), which is exactly the surface we hardened.
 *
 * Live-JWKS verification is an integration concern covered elsewhere.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { authenticate } from '../authenticate.js';

function mockRes(): any {
  const res: any = { headersSent: false };
  res.status  = vi.fn().mockReturnValue(res);
  res.json    = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  return res;
}

function bearer(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

describe('authenticate factory — config validation', () => {
  it('throws when allowedKids is empty', () => {
    expect(() =>
      authenticate({
        jwksUri:     'https://identity.oweibo.io/.well-known/jwks.json',
        issuer:      'https://identity.oweibo.io',
        audience:    'oweibo-api',
        allowedKids: [],
      }),
    ).toThrow(/allowedKids must be a non-empty array/);
  });

  it('throws when jwksUri is plain http to a non-loopback host', () => {
    expect(() =>
      authenticate({
        jwksUri:     'http://identity.internal/.well-known/jwks.json',
        issuer:      'https://identity.oweibo.io',
        audience:    'oweibo-api',
        allowedKids: ['kid-1'],
      }),
    ).toThrow(/refusing to fetch JWKS over insecure transport/);
  });

  it('accepts http to localhost without override (dev convenience)', () => {
    expect(() =>
      authenticate({
        jwksUri:     'http://localhost:3110/.well-known/jwks.json',
        issuer:      'https://identity.oweibo.io',
        audience:    'oweibo-api',
        allowedKids: ['kid-1'],
      }),
    ).not.toThrow();
  });

  it('accepts http when allowInsecureJwksUri=true is set explicitly', () => {
    expect(() =>
      authenticate({
        jwksUri:              'http://identity.internal/.well-known/jwks.json',
        issuer:               'https://identity.oweibo.io',
        audience:             'oweibo-api',
        allowedKids:          ['kid-1'],
        allowInsecureJwksUri: true,
      }),
    ).not.toThrow();
  });

  it('accepts https://', () => {
    expect(() =>
      authenticate({
        jwksUri:     'https://identity.oweibo.io/.well-known/jwks.json',
        issuer:      'https://identity.oweibo.io',
        audience:    'oweibo-api',
        allowedKids: ['kid-1', 'kid-2'],
      }),
    ).not.toThrow();
  });
});

describe('authenticate — pre-JWKS rejections', () => {
  const cfg = {
    jwksUri:     'https://identity.oweibo.io/.well-known/jwks.json',
    issuer:      'https://identity.oweibo.io',
    audience:    'oweibo-api',
    allowedKids: ['oweibo-rs256-v1'],
  };

  it('returns 401 when Authorization header is missing', async () => {
    const mw = authenticate(cfg);
    const req = { headers: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a JWT whose kid is not in the allowlist (no JWKS fetch)', async () => {
    // Sign a token with a different kid using a freshly-generated key.
    // jose will never even try to verify it — our pre-check rejects first.
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'user-1', scopes: [], ctx: { tenantId: 't1' } })
      .setProtectedHeader({ alg: 'RS256', kid: 'attacker-key' })
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const mw  = authenticate(cfg);
    const req = bearer(token);
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a JWT with no kid in the header', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 'user-1', scopes: [], ctx: { tenantId: 't1' } })
      .setProtectedHeader({ alg: 'RS256' })  // no kid
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const mw  = authenticate(cfg);
    const req = bearer(token);
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a JWT signed with a non-RS256 algorithm', async () => {
    // HS256 token — algorithm confusion attempt
    const secret = new Uint8Array(32);
    secret.fill(1);
    const token = await new SignJWT({ sub: 'user-1', scopes: [], ctx: { tenantId: 't1' } })
      .setProtectedHeader({ alg: 'HS256', kid: 'oweibo-rs256-v1' })
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

    const mw  = authenticate(cfg);
    const req = bearer(token);
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-JWT) token cleanly', async () => {
    const mw  = authenticate(cfg);
    const req = bearer('not.a.jwt');
    const res = mockRes();
    const next = vi.fn();
    await mw(req, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// Silence the lint about unused import — exportJWK is referenced from doc-comments.
void exportJWK;
