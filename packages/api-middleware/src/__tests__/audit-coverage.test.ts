/**
 * Audit middleware — action-string coverage tests.
 *
 * Verifies that:
 *  1. audit() correctly calls appendAudit with the configured action string
 *  2. outcome is derived from HTTP status code (allow/deny/error)
 *  3. middleware no-ops when req.principal is absent
 *  4. The complete set of privileged action strings is documented
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@oweibo/db', () => ({
  appendAudit: vi.fn().mockResolvedValue(undefined),
}));

import { audit } from '../audit.js';
import { appendAudit } from '@oweibo/db';

const PRINCIPAL = {
  sub:    'user-1',
  scopes: ['tasks:write'],
  ctx:    { tenantId: 'tenant-1' },
};

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    headers:   {},
    params:    {},
    body:      {},
    ip:        '127.0.0.1',
    path:      '/api/v1/tasks',
    method:    'POST',
    requestId: 'req-test-123',
    ...overrides,
  };
}

function mockRes(statusCode = 201): any {
  const listeners: Record<string, (() => void)[]> = {};
  const res: any = { statusCode };
  res.on     = vi.fn((event: string, cb: () => void) => {
    listeners[event] = listeners[event] ?? [];
    listeners[event].push(cb);
  });
  res.emit   = (event: string) => listeners[event]?.forEach(fn => fn());
  res.status = vi.fn().mockReturnValue(res);
  res.json   = vi.fn().mockReturnValue(res);
  return res;
}

describe('audit middleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls appendAudit with the configured action string on finish', async () => {
    const req  = mockReq({ principal: PRINCIPAL });
    const res  = mockRes(201);
    const next = vi.fn();

    audit('task.create', { resourceType: 'task' })(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    res.emit('finish');
    await Promise.resolve();

    expect(appendAudit).toHaveBeenCalledOnce();
    const row = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(row.action).toBe('task.create');
    expect(row.resourceType).toBe('task');
    expect(row.outcome).toBe('allow');
    expect(row.tenantId).toBe('tenant-1');
    expect(row.actorPrincipal).toBe('user-1');
  });

  it('outcome is "deny" for 4xx response', async () => {
    const req = mockReq({ principal: PRINCIPAL });
    const res = mockRes(403);
    audit('staging.approve')(req, res, vi.fn());
    res.emit('finish');
    await Promise.resolve();
    const row = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(row.outcome).toBe('deny');
  });

  it('outcome is "error" for 5xx response', async () => {
    const req = mockReq({ principal: PRINCIPAL });
    const res = mockRes(500);
    audit('quarantine.override')(req, res, vi.fn());
    res.emit('finish');
    await Promise.resolve();
    const row = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(row.outcome).toBe('error');
  });

  it('no-ops when req.principal is absent', async () => {
    const req = mockReq(); // no principal
    const res = mockRes(200);
    audit('task.create')(req, res, vi.fn());
    res.emit('finish');
    await Promise.resolve();
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it('calls next() immediately (non-blocking)', () => {
    const req  = mockReq({ principal: PRINCIPAL });
    const next = vi.fn();
    audit('task.create')(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('documents the complete privileged action space', () => {
    // All action strings wired across routes — update here when new privileged
    // routes are added so omissions are caught at review time.
    const allActions = [
      // kilo-pipeline/task
      'task.create',
      'task.clear',
      // kilo-pipeline/staging
      'staging.approve',
      'staging.reject',
      // kilo-pipeline/quarantine
      'quarantine.override',
      // identity/platform
      'platform.tenant.create',
      'platform.tenant.update',
      'platform.tenant.suspend',
      'platform.user.roles',
      // identity/tenant
      'tenant.member.invite',
      'tenant.member.roles',
      'tenant.member.remove',
      'tenant.apikey.create',
      'tenant.apikey.revoke',
      'tenant.settings.update',
      // identity/gdpr
      'gdpr.user.erase',
      // memory tier — emitted from QdrantSemanticStore's purge audit hook
      // (gap #8) and from identity's GDPR endpoint per touched tenant.
      'memory.tenant.purge',
      'memory.project.purge',
      'memory.user.purge',
    ];

    for (const action of allActions) {
      expect(action, `malformed action string: "${action}"`).toMatch(/^[\w.]+$/);
    }
    // Ensure no duplicates
    const unique = new Set(allActions);
    expect(unique.size).toBe(allActions.length);
  });
});
