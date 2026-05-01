/**
 * Unit tests for the middleware RBAC logic.
 *
 * We test the helper functions (decodePayload, isExpired, hasScope) in isolation
 * so no Next.js runtime is needed — pure logic tests.
 */
import { describe, it, expect } from 'vitest';

// ── Inline the helpers under test (same logic as middleware.ts) ─────────────

function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isExpired(payload: Record<string, unknown>): boolean {
  return typeof payload['exp'] === 'number' && payload['exp'] < Date.now() / 1000;
}

function hasScope(payload: Record<string, unknown>, scope: string): boolean {
  const scopes = payload['scopes'];
  return Array.isArray(scopes) && scopes.includes(scope);
}

function makeToken(payload: Record<string, unknown>): string {
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

// ── decodePayload ──────────────────────────────────────────────────────────

describe('decodePayload', () => {
  it('returns null for a non-JWT string', () => {
    expect(decodePayload('not-a-jwt')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    expect(decodePayload('hdr.!!!.sig')).toBeNull();
  });

  it('decodes a valid payload', () => {
    const token   = makeToken({ sub: 'user-1', scopes: ['tasks:read'] });
    const payload = decodePayload(token);
    expect(payload).not.toBeNull();
    expect(payload!['sub']).toBe('user-1');
  });
});

// ── isExpired ──────────────────────────────────────────────────────────────

describe('isExpired', () => {
  it('returns false when exp is in the future', () => {
    expect(isExpired({ exp: Math.floor(Date.now() / 1000) + 3600 })).toBe(false);
  });

  it('returns true when exp is in the past', () => {
    expect(isExpired({ exp: Math.floor(Date.now() / 1000) - 1 })).toBe(true);
  });

  it('returns false when exp is absent', () => {
    expect(isExpired({})).toBe(false);
  });
});

// ── hasScope ───────────────────────────────────────────────────────────────

describe('hasScope', () => {
  const payload = { scopes: ['tasks:read', 'staging:read', 'platform:tenants:read'] };

  it('returns true for a scope that is present', () => {
    expect(hasScope(payload, 'tasks:read')).toBe(true);
    expect(hasScope(payload, 'platform:tenants:read')).toBe(true);
  });

  it('returns false for a scope that is absent', () => {
    expect(hasScope(payload, 'tasks:write')).toBe(false);
  });

  it('returns false when scopes field is missing', () => {
    expect(hasScope({}, 'tasks:read')).toBe(false);
  });

  it('returns false when scopes is not an array', () => {
    expect(hasScope({ scopes: 'tasks:read' }, 'tasks:read')).toBe(false);
  });
});

// ── RBAC scenario tests ────────────────────────────────────────────────────

describe('RBAC scenarios', () => {
  it('platform_admin has platform:tenants:read scope', () => {
    const token = makeToken({
      sub:    'admin-1',
      scopes: ['platform:tenants:read', 'platform:tenants:write'],
      exp:    Math.floor(Date.now() / 1000) + 900,
    });
    const payload = decodePayload(token)!;
    expect(hasScope(payload, 'platform:tenants:read')).toBe(true);
    expect(isExpired(payload)).toBe(false);
  });

  it('tenant_viewer has tasks:read but not platform:tenants:read', () => {
    const token = makeToken({
      sub:    'viewer-1',
      scopes: ['tasks:read', 'staging:read'],
      exp:    Math.floor(Date.now() / 1000) + 900,
    });
    const payload = decodePayload(token)!;
    expect(hasScope(payload, 'tasks:read')).toBe(true);
    expect(hasScope(payload, 'platform:tenants:read')).toBe(false);
  });

  it('expired token is detected correctly', () => {
    const token = makeToken({
      sub:    'user-1',
      scopes: ['tasks:read'],
      exp:    Math.floor(Date.now() / 1000) - 60,
    });
    const payload = decodePayload(token)!;
    expect(isExpired(payload)).toBe(true);
  });
});
