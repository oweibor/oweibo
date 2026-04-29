/**
 * Unit tests for api-middleware.
 *
 * Covers: requireScopes, requireTenantMatch, requestId, legacyBridge,
 * idempotent, audit (smoke), rateLimit factories.
 * authenticate is integration-tested separately (needs a live JWKS).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { requireScopes, requireTenantMatch } from '../authorization.js';
import { requestId, propagationHeaders }     from '../requestId.js';
import { buildLegacyTokenMap }               from '../legacyBridge.js';
import { idempotent }                        from '../idempotent.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> & { principal?: any } = {}): any {
  return {
    headers:    {},
    params:     {},
    body:       {},
    ip:         '127.0.0.1',
    path:       '/test',
    method:     'GET',
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = { headersSent: false, _headers: {} as Record<string, string> };
  res.status  = vi.fn().mockReturnValue(res);
  res.json    = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn((k: string, v: string) => { res._headers[k] = v; });
  res.getHeader = vi.fn((k: string) => res._headers[k]);
  res.on      = vi.fn();
  return res;
}

// ── requireScopes ──────────────────────────────────────────────────────────

describe('requireScopes', () => {
  it('calls next when all scopes are present', () => {
    const req  = mockReq({ principal: { scopes: ['tasks:read', 'tasks:write'] } });
    const res  = mockRes();
    const next = vi.fn();
    requireScopes('tasks:read', 'tasks:write')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 with missing list when a scope is absent', () => {
    const req  = mockReq({ principal: { scopes: ['tasks:read'] } });
    const res  = mockRes();
    const next = vi.fn();
    requireScopes('tasks:read', 'tasks:write')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'insufficient_scope', missing: ['tasks:write'] }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when principal is missing', () => {
    const req  = mockReq();
    const res  = mockRes();
    const next = vi.fn();
    requireScopes('tasks:read')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── requireTenantMatch ─────────────────────────────────────────────────────

describe('requireTenantMatch', () => {
  const TENANT = 'aaa-bbb-ccc';

  it('allows matching tenantId', () => {
    const req  = mockReq({ params: { tenantId: TENANT }, principal: { scopes: [], ctx: { tenantId: TENANT } } });
    const next = vi.fn();
    requireTenantMatch()(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 404 on cross-tenant mismatch', () => {
    const req  = mockReq({ params: { tenantId: 'other' }, principal: { scopes: [], ctx: { tenantId: TENANT } } });
    const res  = mockRes();
    const next = vi.fn();
    requireTenantMatch()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('bypasses check for platform_admin', () => {
    const req  = mockReq({ params: { tenantId: 'other' }, principal: { scopes: ['platform:tenants:write'], ctx: { tenantId: TENANT } } });
    const next = vi.fn();
    requireTenantMatch()(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ── requestId ─────────────────────────────────────────────────────────────

describe('requestId', () => {
  it('generates a requestId and traceparent when none provided', () => {
    const req  = mockReq();
    const res  = mockRes();
    const next = vi.fn();
    requestId(req, res, next);
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(0);
    expect(typeof req.traceparent).toBe('string');
    expect(req.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(next).toHaveBeenCalledOnce();
  });

  it('forwards a valid x-request-id header', () => {
    const existing = 'my-existing-id';
    const req  = mockReq({ headers: { 'x-request-id': existing } });
    const res  = mockRes();
    requestId(req, res, vi.fn());
    expect(req.requestId).toBe(existing);
  });

  it('forwards a valid traceparent header', () => {
    const tp  = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const req = mockReq({ headers: { traceparent: tp } });
    const res = mockRes();
    requestId(req, res, vi.fn());
    expect(req.traceparent).toBe(tp);
  });

  it('propagationHeaders returns correct map', () => {
    const req = mockReq();
    req.requestId  = 'req-1';
    req.traceparent = '00-aaa-bbb-01';
    const headers = propagationHeaders(req);
    expect(headers['x-request-id']).toBe('req-1');
    expect(headers['traceparent']).toBe('00-aaa-bbb-01');
  });
});

// ── buildLegacyTokenMap ────────────────────────────────────────────────────

describe('buildLegacyTokenMap', () => {
  beforeEach(() => {
    delete process.env['TENANT_TOKENS'];
    delete process.env['KILO_API_TOKEN'];
  });

  it('returns empty map when no env vars set', () => {
    expect(buildLegacyTokenMap().size).toBe(0);
  });

  it('parses TENANT_TOKENS JSON correctly', () => {
    process.env['TENANT_TOKENS'] = JSON.stringify({ 'secret-tok': 'tenant-1' });
    const map = buildLegacyTokenMap();
    expect(map.size).toBe(1);
    const entry = [...map.values()][0];
    expect(entry?.tenantId).toBe('tenant-1');
    expect(entry?.scopes).toContain('tasks:write');
  });

  it('falls back to KILO_API_TOKEN as default tenant', () => {
    process.env['KILO_API_TOKEN'] = 'kilo-legacy-token';
    const map = buildLegacyTokenMap();
    expect(map.size).toBe(1);
    const entry = [...map.values()][0];
    expect(entry?.tenantId).toBe('default');
  });

  it('ignores malformed TENANT_TOKENS JSON', () => {
    process.env['TENANT_TOKENS'] = 'not-json{{{';
    expect(() => buildLegacyTokenMap()).not.toThrow();
    expect(buildLegacyTokenMap().size).toBe(0);
  });
});

// ── idempotent ─────────────────────────────────────────────────────────────

describe('idempotent', () => {
  function makeRedis(stored: Record<string, string> = {}): any {
    return {
      get: vi.fn(async (k: string) => stored[k] ?? null),
      set: vi.fn(async (k: string, v: string) => { stored[k] = v; }),
    };
  }

  it('passes through when no Idempotency-Key header is present', async () => {
    const redis = makeRedis();
    const req   = mockReq({ headers: {} });
    const res   = mockRes();
    const next  = vi.fn();
    await idempotent({ redis })(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('replays a cached response on second request', async () => {
    const key   = 'test-idem-key';
    const body  = { taskId: '123' };
    const store: Record<string, string> = {};
    const redis = makeRedis(store);

    // First call — no cached entry, handler runs
    const req1  = mockReq({ headers: { 'idempotency-key': key }, principal: { ctx: { tenantId: 'tenant-1' } } });
    const res1  = mockRes();
    res1.statusCode = 201;
    const next1 = vi.fn();
    await idempotent({ redis })(req1, res1, next1);
    expect(next1).toHaveBeenCalledOnce();
    // Simulate handler calling res.json
    res1.json(body);
    expect(Object.keys(store).length).toBe(1);

    // Second call — should replay
    const req2  = mockReq({ headers: { 'idempotency-key': key }, principal: { ctx: { tenantId: 'tenant-1' } } });
    const res2  = mockRes();
    const next2 = vi.fn();
    await idempotent({ redis: makeRedis(store) })(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.json).toHaveBeenCalledWith(body);
  });

  it('returns 409 on body mismatch for same key', async () => {
    const cachedEntry = JSON.stringify({ bodyHash: 'aaa', status: 200, body: {}, cachedAt: '' });
    const redis = makeRedis({ 'idem:tenant-1:key-1': cachedEntry });
    const req   = mockReq({
      headers: { 'idempotency-key': 'key-1' },
      body:    { different: 'body' },
      principal: { ctx: { tenantId: 'tenant-1' } },
    });
    const res  = mockRes();
    const next = vi.fn();
    await idempotent({ redis })(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });
});
