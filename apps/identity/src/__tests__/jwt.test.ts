/**
 * JWT mint / verify round-trip tests.
 *
 * Uses a freshly generated in-process RS256 keypair so no env setup is needed.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

// We mock the config and the jwks module before importing jwt.ts
vi.mock('../config.js', () => ({
  config: {
    JWT_ISSUER:       'https://test.identity.oweibo.io',
    JWT_AUDIENCE:     'oweibo-api-test',
    JWT_KEY_ID:       'test-key-1',
    ACCESS_TOKEN_TTL: 900,
  },
}));

let mintAccessToken: (p: any) => Promise<string>;
let verifyAccessToken: (t: string) => Promise<any>;
let mintAgentToken: (opts: any) => Promise<string>;
let initKeys: () => Promise<void>;
let getPrivateKey: () => any;
let getPublicKey: () => any;

beforeAll(async () => {
  // Generate a real RS256 keypair for tests
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const privatePem = await exportPKCS8(privateKey);
  const publicPem  = await exportSPKI(publicKey);

  // Patch the jwks module to use the test keypair
  vi.mock('../services/jwks.js', () => ({
    initKeys:      vi.fn().mockResolvedValue(undefined),
    getPrivateKey: () => privateKey,
    getPublicKey:  () => publicKey,
    getJwks:       () => ({ keys: [] }),
  }));

  // Import after mocking
  const jwtMod = await import('../services/jwt.js');
  mintAccessToken  = jwtMod.mintAccessToken;
  verifyAccessToken = jwtMod.verifyAccessToken;
  mintAgentToken   = jwtMod.mintAgentToken;
});

describe('mintAccessToken / verifyAccessToken', () => {
  it('round-trips a user token with all required claims', async () => {
    const principal = {
      sub:    'user-abc-123',
      kind:   'user' as const,
      scopes: ['tasks:read', 'tasks:write'],
      ctx:    { tenantId: 'tenant-xyz' },
    };
    const token   = await mintAccessToken(principal);
    const claims  = await verifyAccessToken(token);

    expect(claims.sub).toBe('user-abc-123');
    expect(claims.ctx.tenantId).toBe('tenant-xyz');
    expect(claims.scopes).toEqual(['tasks:read', 'tasks:write']);
    expect(claims.trust).toBe('supervised');
    expect(claims.iss).toBe('https://test.identity.oweibo.io');
    expect(claims.aud).toBe('oweibo-api-test');
    expect(typeof claims.jti).toBe('string');
  });

  it('sets trust=graduated when trust:graduated scope is present', async () => {
    const token  = await mintAccessToken({
      sub: 'u2', kind: 'user', ctx: { tenantId: 't1' },
      scopes: ['tasks:write', 'trust:graduated'],
    });
    const claims = await verifyAccessToken(token);
    expect(claims.trust).toBe('graduated');
  });

  it('sets trust=autonomous when trust:autonomous scope is present', async () => {
    const token  = await mintAccessToken({
      sub: 'u3', kind: 'user', ctx: { tenantId: 't1' },
      scopes: ['tasks:write', 'trust:autonomous'],
    });
    const claims = await verifyAccessToken(token);
    expect(claims.trust).toBe('autonomous');
  });

  it('includes act_as on agent principal', async () => {
    const token  = await mintAccessToken({
      sub:    'agent:run-001',
      kind:   'agent',
      ctx:    { tenantId: 'tenant-abc' },
      scopes: ['tasks:read'],
      actAs:  { sub: 'user-abc-123', tenantId: 'tenant-abc' },
    });
    const claims = await verifyAccessToken(token);
    expect(claims.act_as?.sub).toBe('user-abc-123');
  });

  it('rejects a token signed with a different key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ sub: 'hacker' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://test.identity.oweibo.io')
      .setAudience('oweibo-api-test')
      .setExpirationTime('15m')
      .sign(otherKey);
    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });
});

describe('mintAgentToken', () => {
  it('restricts scopes to intersection of parent and agent scopes', async () => {
    const token  = await mintAgentToken({
      taskId:   'task-1',
      runId:    'run-1',
      userId:   'user-abc',
      tenantId: 'tenant-abc',
      parentScopes: ['tasks:read', 'tasks:write', 'memory:read'],
      agentScopes:  ['tasks:read', 'memory:read', 'ledger:write'], // ledger:write not in parent
      taskBudgetRemainingMs: 30 * 60 * 1000,
    });
    const claims = await verifyAccessToken(token);
    expect(claims.scopes).toContain('tasks:read');
    expect(claims.scopes).toContain('memory:read');
    expect(claims.scopes).not.toContain('tasks:write');
    expect(claims.scopes).not.toContain('ledger:write');
    expect(claims.act_as?.sub).toBe('user-abc');
  });

  it('caps TTL at 60 min regardless of task budget', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintAgentToken({
      taskId: 'task-2', runId: 'run-2', userId: 'u', tenantId: 't',
      parentScopes: ['tasks:read'], agentScopes: ['tasks:read'],
      taskBudgetRemainingMs: 8 * 60 * 60 * 1000, // 8 hours — should be capped
    });
    const claims = await verifyAccessToken(token);
    const ttl = (claims.exp ?? 0) - now;
    expect(ttl).toBeLessThanOrEqual(60 * 60 + 5); // 60 min + 5s clock slack
  });
});
