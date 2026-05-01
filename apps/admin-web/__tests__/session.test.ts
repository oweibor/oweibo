/**
 * Unit tests for session helper functions (lib/auth.ts pure logic).
 *
 * Uses the same helpers extracted from lib/auth.ts without the Next.js
 * server-only imports (cookies, redirect).
 */
import { describe, it, expect } from 'vitest';

// ── Re-implement the pure helpers under test ───────────────────────────────

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, encoded] = token.split('.');
    if (!encoded) return null;
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface SessionUser {
  user_id:   string;
  email:     string | null;
  tenant_id: string | null;
  scopes:    string[];
  trust:     string;
}

function payloadToSessionUser(payload: Record<string, unknown>): SessionUser {
  return {
    user_id:   (payload['sub'] as string) ?? '',
    email:     (payload['email'] as string) ?? null,
    tenant_id: ((payload['ctx'] as any)?.tenantId as string) || null,
    scopes:    (payload['scopes'] as string[]) ?? [],
    trust:     (payload['trust'] as string) ?? 'supervised',
  };
}

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

// ── parseJwtPayload ────────────────────────────────────────────────────────

describe('parseJwtPayload', () => {
  it('returns null for empty string', () => {
    expect(parseJwtPayload('')).toBeNull();
  });

  it('returns null for a single-segment string', () => {
    expect(parseJwtPayload('notajwt')).toBeNull();
  });

  it('parses a well-formed token', () => {
    const token   = makeToken({ sub: 'u1', scopes: ['tasks:read'], ctx: { tenantId: 't1' } });
    const payload = parseJwtPayload(token);
    expect(payload).not.toBeNull();
    expect(payload!['sub']).toBe('u1');
  });
});

// ── payloadToSessionUser ───────────────────────────────────────────────────

describe('payloadToSessionUser', () => {
  it('maps all fields correctly', () => {
    const user = payloadToSessionUser({
      sub:    'u1',
      email:  'a@b.com',
      ctx:    { tenantId: 't1' },
      scopes: ['tasks:read', 'staging:read'],
      trust:  'graduated',
    });
    expect(user).toEqual({
      user_id:   'u1',
      email:     'a@b.com',
      tenant_id: 't1',
      scopes:    ['tasks:read', 'staging:read'],
      trust:     'graduated',
    });
  });

  it('uses defaults for missing fields', () => {
    const user = payloadToSessionUser({});
    expect(user.user_id).toBe('');
    expect(user.email).toBeNull();
    expect(user.tenant_id).toBeNull();
    expect(user.scopes).toEqual([]);
    expect(user.trust).toBe('supervised');
  });

  it('treats empty tenant_id as null', () => {
    const user = payloadToSessionUser({ ctx: { tenantId: '' } });
    expect(user.tenant_id).toBeNull();
  });
});

// ── round-trip ────────────────────────────────────────────────────────────

describe('token round-trip', () => {
  it('makeToken → parseJwtPayload → payloadToSessionUser is lossless', () => {
    const original = {
      sub:    'u-123',
      email:  'test@oweibo.io',
      ctx:    { tenantId: 'tenant-xyz' },
      scopes: ['tasks:read', 'tasks:write', 'staging:read'],
      trust:  'autonomous',
      exp:    Math.floor(Date.now() / 1000) + 900,
    };

    const token   = makeToken(original);
    const payload = parseJwtPayload(token)!;
    const user    = payloadToSessionUser(payload);

    expect(user.user_id).toBe(original.sub);
    expect(user.email).toBe(original.email);
    expect(user.tenant_id).toBe(original.ctx.tenantId);
    expect(user.scopes).toEqual(original.scopes);
    expect(user.trust).toBe(original.trust);
  });
});
