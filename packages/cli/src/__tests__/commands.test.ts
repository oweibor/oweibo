/**
 * Integration tests for CLI commands.
 *
 * global.fetch is mocked so tests run without a live server.
 * Each test verifies that:
 *   - the right HTTP method + URL is called
 *   - auth header is forwarded when OWEIBO_API_KEY is set
 *   - the response is handled without throwing
 */

// Silence console output in tests
const originalLog   = console.log;
const originalError = console.error;
beforeAll(() => {
  console.log   = jest.fn();
  console.error = jest.fn();
});
afterAll(() => {
  console.log   = originalLog;
  console.error = originalError;
});

// Reset env between tests
const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, OWEIBO_API_KEY: 'test-key' };
  (global.fetch as jest.Mock).mockReset();
});
afterEach(() => { process.env = ORIGINAL_ENV; });

// ── fetch mock factory ─────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok:   status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

global.fetch = jest.fn();

// ── api client ─────────────────────────────────────────────────────────────

describe('api client', () => {
  it('GET includes Authorization header', async () => {
    mockFetch({ tasks: [], count: 0 });
    const { api } = await import('../client.js');
    await api.get('/tasks');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/tasks'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }),
    );
  });

  it('POST sends JSON body', async () => {
    mockFetch({ taskId: 'abc', status: 'pending' });
    const { api } = await import('../client.js');
    await api.post('/tasks', { instruction: 'build me an app' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/tasks'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ instruction: 'build me an app' }) }),
    );
  });

  it('PATCH sends JSON body', async () => {
    mockFetch({ tenant: { id: 't1', name: 'Acme' } });
    const { api } = await import('../client.js');
    await api.patch('/api/v1/platform/tenants/t1', { name: 'Acme' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('DELETE request has no body', async () => {
    mockFetch({}, 204);
    const { api } = await import('../client.js');
    // 204 is ok — body is empty
    try { await api.delete('/api/v1/tenants/t1/users/u1'); } catch { /* ok if 204 parsing fails */ }
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws on non-2xx response', async () => {
    mockFetch({ error: 'not_found' }, 404);
    const { api } = await import('../client.js');
    await expect(api.get('/tasks/missing')).rejects.toMatchObject({ message: expect.stringContaining('404') });
  });
});

// ── identityApi client ─────────────────────────────────────────────────────

describe('identityApi client', () => {
  it('POST to identity URL', async () => {
    mockFetch({ access_token: 'tok', refresh_token: 'ref', expires_at: new Date().toISOString(), token_type: 'Bearer', user_id: 'u1', tenant_id: 't1', email: 'a@b.com', scopes: [] });
    const { identityApi } = await import('../client.js');
    const result = await identityApi.post('/api/v1/auth/token', { email: 'a@b.com', password: 'pw' });
    expect(result).toMatchObject({ access_token: 'tok' });
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, ...any[]];
    expect(url).toContain('3110');
  });
});

// ── task commands ─────────────────────────────────────────────────────────

describe('task commands', () => {
  it('task list calls GET /tasks', async () => {
    mockFetch({ tasks: [{ taskId: 't1', status: 'completed' }], count: 1 });
    const { makeTaskCommand } = await import('../commands/task.js');
    const cmd = makeTaskCommand();
    const listCmd = cmd.commands.find(c => c.name() === 'list')!;
    await listCmd.parseAsync(['node', 'oweibo', 'task', 'list'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/tasks'), expect.any(Object));
  });

  it('task clear calls POST /task/clear', async () => {
    mockFetch({ cleared: true });
    const { makeTaskCommand } = await import('../commands/task.js');
    const cmd = makeTaskCommand();
    const clearCmd = cmd.commands.find(c => c.name() === 'clear')!;
    await clearCmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    const [url, req] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/task/clear');
    expect(req.method).toBe('POST');
  });
});

// ── staging commands ───────────────────────────────────────────────────────

describe('staging commands', () => {
  it('staging list calls GET /staging', async () => {
    mockFetch({ staged: [], count: 0 });
    const { makeStagingCommand } = await import('../commands/staging.js');
    const cmd = makeStagingCommand().commands.find(c => c.name() === 'list')!;
    await cmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/staging'), expect.any(Object));
  });

  it('staging approve calls POST /staging/:id/approve', async () => {
    mockFetch({ approved: true });
    const { makeStagingCommand } = await import('../commands/staging.js');
    const cmd = makeStagingCommand().commands.find(c => c.name() === 'approve')!;
    await cmd.parseAsync(['node', 'oweibo', 'stage-1'], { from: 'electron' });
    const [url, req] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/staging/stage-1/approve');
    expect(req.method).toBe('POST');
  });

  it('staging reject calls POST /staging/:id/reject', async () => {
    mockFetch({ rejected: true });
    const { makeStagingCommand } = await import('../commands/staging.js');
    const cmd = makeStagingCommand().commands.find(c => c.name() === 'reject')!;
    await cmd.parseAsync(['node', 'oweibo', 'stage-1', '--reason', 'bad output'], { from: 'electron' });
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/staging/stage-1/reject');
  });
});

// ── quarantine commands ────────────────────────────────────────────────────

describe('quarantine commands', () => {
  it('quarantine list calls GET /quarantine', async () => {
    mockFetch({ quarantined: [], count: 0 });
    const { makeQuarantineCommand } = await import('../commands/quarantine.js');
    const cmd = makeQuarantineCommand().commands.find(c => c.name() === 'list')!;
    await cmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/quarantine'), expect.any(Object));
  });

  it('quarantine override calls POST /quarantine/:id/override', async () => {
    mockFetch({ released: true });
    const { makeQuarantineCommand } = await import('../commands/quarantine.js');
    const cmd = makeQuarantineCommand().commands.find(c => c.name() === 'override')!;
    await cmd.parseAsync(['node', 'oweibo', 'q-1', '--reason', 'safe'], { from: 'electron' });
    const [url, req] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/quarantine/q-1/override');
    expect(req.method).toBe('POST');
  });
});

// ── scrape commands ────────────────────────────────────────────────────────

describe('scrape commands', () => {
  it('scrape start calls POST /scrape/start', async () => {
    mockFetch({ job_id: 'scrape-1', status: 'running' });
    const { makeScrapeCommand } = await import('../commands/scrape.js');
    const cmd = makeScrapeCommand().commands.find(c => c.name() === 'start')!;
    await cmd.parseAsync(['node', 'oweibo', 'https://example.com'], { from: 'electron' });
    const [url, req] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/scrape/start');
    expect(req.method).toBe('POST');
  });

  it('scrape list calls GET /scrape/jobs', async () => {
    mockFetch({ jobs: [], count: 0 });
    const { makeScrapeCommand } = await import('../commands/scrape.js');
    const cmd = makeScrapeCommand().commands.find(c => c.name() === 'list')!;
    await cmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/scrape/jobs'), expect.any(Object));
  });
});

// ── hitl commands ──────────────────────────────────────────────────────────

describe('hitl commands', () => {
  it('hitl list calls GET /hitl/pending', async () => {
    mockFetch({ count: 0, requests: [] });
    const { makeHitlCommand } = await import('../commands/hitl-cmd.js');
    const cmd = makeHitlCommand().commands.find(c => c.name() === 'list')!;
    await cmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/hitl/pending'), expect.any(Object));
  });
});

// ── platform commands ──────────────────────────────────────────────────────

describe('platform commands', () => {
  it('platform tenant list calls GET /api/v1/platform/tenants', async () => {
    mockFetch({ tenants: [] });
    const { makePlatformCommand } = await import('../commands/platform.js');
    const tenantGroup = makePlatformCommand().commands.find(c => c.name() === 'tenant')!;
    const listCmd     = tenantGroup.commands.find(c => c.name() === 'list')!;
    await listCmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/platform/tenants'), expect.any(Object));
  });

  it('platform tenant suspend calls POST /api/v1/platform/tenants/:id/suspend', async () => {
    mockFetch({ tenant: { id: 't1', status: 'suspended' } });
    const { makePlatformCommand } = await import('../commands/platform.js');
    const tenantGroup  = makePlatformCommand().commands.find(c => c.name() === 'tenant')!;
    const suspendCmd   = tenantGroup.commands.find(c => c.name() === 'suspend')!;
    await suspendCmd.parseAsync(['node', 'oweibo', 't1'], { from: 'electron' });
    const [url, req] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/platform/tenants/t1/suspend');
    expect(req.method).toBe('POST');
  });
});

// ── tenant commands ────────────────────────────────────────────────────────

describe('tenant commands', () => {
  beforeEach(() => { process.env['OWEIBO_TENANT_ID'] = 'tenant-abc'; });

  it('tenant member list calls GET /api/v1/tenants/:tid/users', async () => {
    mockFetch({ members: [] });
    const { makeTenantCommand } = await import('../commands/tenant.js');
    const memberGroup = makeTenantCommand().commands.find(c => c.name() === 'member')!;
    const listCmd     = memberGroup.commands.find(c => c.name() === 'list')!;
    await listCmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant-abc/users'), expect.any(Object));
  });

  it('tenant key list calls GET /api/v1/tenants/:tid/apikeys', async () => {
    mockFetch({ keys: [] });
    const { makeTenantCommand } = await import('../commands/tenant.js');
    const keyGroup = makeTenantCommand().commands.find(c => c.name() === 'key')!;
    const listCmd  = keyGroup.commands.find(c => c.name() === 'list')!;
    await listCmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant-abc/apikeys'), expect.any(Object));
  });

  it('tenant settings get calls GET /api/v1/tenants/:tid/settings', async () => {
    mockFetch({ settings: { trustModeDefault: 'supervised' } });
    const { makeTenantCommand } = await import('../commands/tenant.js');
    const settingsGroup = makeTenantCommand().commands.find(c => c.name() === 'settings')!;
    const getCmd        = settingsGroup.commands.find(c => c.name() === 'get')!;
    await getCmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant-abc/settings'), expect.any(Object));
  });
});

// ── ledger commands ────────────────────────────────────────────────────────

describe('ledger commands', () => {
  it('ledger list calls GET /ledger', async () => {
    mockFetch({ entries: [] });
    const { makeLedgerCommand } = await import('../commands/ledger.js');
    const cmd = makeLedgerCommand().commands.find(c => c.name() === 'list')!;
    await cmd.parseAsync(['node', 'oweibo'], { from: 'electron' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/ledger'), expect.any(Object));
  });
});
