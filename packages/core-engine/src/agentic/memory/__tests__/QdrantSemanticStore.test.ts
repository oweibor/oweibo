/**
 * Unit tests for QdrantSemanticStore — verify contract behaviour without
 * a live Qdrant instance.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { QdrantSemanticStore, SemanticStoreCapExceededError } from '../QdrantSemanticStore.js';
import { MemoryCircuitBreaker, MemoryCircuitOpenError } from '../MemoryCircuitBreaker.js';
import type { StoreMemoryInput, MemoryScope } from '@oweibo/core-contracts';

const TENANT  = 't-1';
const USER    = 'u-1';
const PROJECT = 'p-1';
const SCOPE: MemoryScope = { tenantId: TENANT, userId: USER, projectId: PROJECT };
const COLLECTION = `agent-ltm:${TENANT}`;

function makeQdrant(overrides: Record<string, any> = {}): any {
  return {
    getCollection:    jest.fn<() => Promise<any>>().mockResolvedValue({ points_count: 0 }),
    createCollection: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    upsert:           jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    search:           jest.fn<() => Promise<any>>().mockResolvedValue([]),
    delete:           jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    retrieve:         jest.fn<() => Promise<any>>().mockResolvedValue([]),
    setPayload:       jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

const embedder = jest.fn<(text: string) => Promise<number[]>>(async () => Array(8).fill(0.1));

function input(overrides: Partial<StoreMemoryInput> = {}): StoreMemoryInput {
  return {
    scope:      SCOPE,
    kind:       'domain-fact',
    summary:    'a test memory',
    importance: 0.5,
    ...overrides,
  };
}

beforeEach(() => {
  embedder.mockClear();
});

describe('QdrantSemanticStore.store', () => {
  it('persists user_id, project_id, and tags in the payload', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder, config: { vectorDimension: 8 } });

    await store.store(input({ tags: ['feature/auth', 'bug'] }));

    expect(qdrant.upsert).toHaveBeenCalledTimes(1);
    const [collection, body] = qdrant.upsert.mock.calls[0];
    expect(collection).toBe(COLLECTION);
    const payload = body.points[0].payload;
    expect(payload.tenant_id).toBe(TENANT);
    expect(payload.user_id).toBe(USER);
    expect(payload.project_id).toBe(PROJECT);
    expect(payload.tags).toEqual(['feature/auth', 'bug']);
    expect(payload.recall_count).toBe(0);
  });

  it('returns a MemoryEntry with the full scope (including userId)', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder, config: { vectorDimension: 8 } });

    const entry = await store.store(input());
    expect(entry.scope.userId).toBe(USER);
    expect(entry.scope.tenantId).toBe(TENANT);
    expect(entry.scope.projectId).toBe(PROJECT);
  });

  it('rejects kinds owned by other tiers', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder });
    await expect(store.store(input({ kind: 'user-preference' }))).rejects.toThrow(/must not be stored/);
    await expect(store.store(input({ kind: 'project-invariant' }))).rejects.toThrow(/must not be stored/);
    await expect(store.store(input({ kind: 'conversation-summary' }))).rejects.toThrow(/must not be stored/);
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('throws SemanticStoreCapExceededError when collection is full', async () => {
    const qdrant = makeQdrant({
      getCollection: jest.fn().mockResolvedValue({ points_count: 100_000 }),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder, config: { maxEntriesPerTenant: 100_000 } });
    await expect(store.store(input())).rejects.toBeInstanceOf(SemanticStoreCapExceededError);
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('reinforces an existing entry on dedup hit instead of upserting', async () => {
    const qdrant = makeQdrant({
      search:   jest.fn().mockResolvedValue([{ id: 'dup-id' }]),
      retrieve: jest.fn().mockResolvedValue([{
        id: 'dup-id',
        payload: {
          tenant_id: TENANT, user_id: USER, project_id: PROJECT,
          kind: 'domain-fact', summary: 'a test memory',
          importance: 0.5, recall_count: 7,
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          tags: [],
        },
      }]),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder });

    const entry = await store.store(input());
    expect(entry.id).toBe('dup-id');
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect(qdrant.setPayload).toHaveBeenCalledTimes(1);
  });
});

describe('QdrantSemanticStore.recall', () => {
  it('returns ranked results with full scoreBreakdown', async () => {
    const qdrant = makeQdrant({
      search: jest.fn().mockResolvedValue([{
        id: 'r-1', score: 0.9,
        payload: {
          tenant_id: TENANT, user_id: USER,
          kind: 'failure-lesson', summary: 'something failed',
          importance: 0.8, recall_count: 3,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [],
        },
      }]),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder });

    const results = await store.recall({ tenantId: TENANT, query: 'why did it fail' });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.scoreBreakdown.semantic).toBe(0.9);
    expect(r.scoreBreakdown.recency).toBeGreaterThan(0.99);  // updated just now
    expect(r.scoreBreakdown.importance).toBe(0.8);
    expect(r.scoreBreakdown.kindBoost).toBe(1.3);            // failure-lesson default
    expect(r.scope.userId).toBe(USER);
  });

  it('returns empty array when collection does not exist', async () => {
    const qdrant = makeQdrant({
      search: jest.fn().mockRejectedValue(new Error('not found')),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder });

    const results = await store.recall({ tenantId: TENANT, query: 'x' });
    expect(results).toEqual([]);
  });

  it('passes projectId and kinds filters into the Qdrant query', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder });

    await store.recall({
      tenantId:  TENANT,
      query:     'x',
      projectId: PROJECT,
      kinds:     ['domain-fact', 'code-landmark'],
    });

    const [, body] = qdrant.search.mock.calls[0];
    const must = body.filter.must;
    expect(must).toContainEqual({ key: 'tenant_id',  match: { value: TENANT } });
    expect(must).toContainEqual({ key: 'project_id', match: { value: PROJECT } });
    expect(must).toContainEqual({ key: 'kind', match: { any: ['domain-fact', 'code-landmark'] } });
  });
});

describe('QdrantSemanticStore.purge*', () => {
  it('purgeTenant filters by tenant_id only', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder });

    await store.purgeTenant(TENANT);
    expect(qdrant.delete).toHaveBeenCalledTimes(1);
    const [collection, body] = qdrant.delete.mock.calls[0];
    expect(collection).toBe(COLLECTION);
    expect(body.filter.must).toEqual([{ key: 'tenant_id', match: { value: TENANT } }]);
  });

  it('purgeProject filters by tenant_id AND project_id', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder });

    await store.purgeProject(TENANT, PROJECT);
    const [, body] = qdrant.delete.mock.calls[0];
    expect(body.filter.must).toContainEqual({ key: 'tenant_id',  match: { value: TENANT } });
    expect(body.filter.must).toContainEqual({ key: 'project_id', match: { value: PROJECT } });
  });

  it('purgeUser filters by tenant_id AND user_id (GDPR per-user erasure)', async () => {
    const qdrant = makeQdrant();
    const store  = new QdrantSemanticStore({ qdrant, embedder });

    await store.purgeUser(TENANT, USER);
    expect(qdrant.delete).toHaveBeenCalledTimes(1);
    const [collection, body] = qdrant.delete.mock.calls[0];
    expect(collection).toBe(COLLECTION);
    expect(body.filter.must).toContainEqual({ key: 'tenant_id', match: { value: TENANT } });
    expect(body.filter.must).toContainEqual({ key: 'user_id',   match: { value: USER } });
  });

  it('purge methods reject empty ids', async () => {
    const store = new QdrantSemanticStore({ qdrant: makeQdrant(), embedder });
    await expect(store.purgeTenant('')).rejects.toThrow(/tenantId is required/);
    await expect(store.purgeProject('', PROJECT)).rejects.toThrow(/tenantId is required/);
    await expect(store.purgeProject(TENANT, '')).rejects.toThrow(/projectId is required/);
    await expect(store.purgeUser('', USER)).rejects.toThrow(/tenantId is required/);
    await expect(store.purgeUser(TENANT, '')).rejects.toThrow(/userId is required/);
  });
});

describe('QdrantSemanticStore — purge audit hook', () => {
  it('fires the auditor with action=memory.tenant.purge after purgeTenant succeeds', async () => {
    const audit  = jest.fn<(e: unknown) => void>().mockReturnValue(undefined);
    const store  = new QdrantSemanticStore({ qdrant: makeQdrant(), embedder, audit });
    await store.purgeTenant(TENANT);
    expect(audit).toHaveBeenCalledTimes(1);
    const event = (audit as any).mock.calls[0][0];
    expect(event.action).toBe('memory.tenant.purge');
    expect(event.tenantId).toBe(TENANT);
    expect(event.ts).toBeInstanceOf(Date);
  });

  it('fires action=memory.project.purge with projectId from purgeProject', async () => {
    const audit = jest.fn<(e: unknown) => void>().mockReturnValue(undefined);
    const store = new QdrantSemanticStore({ qdrant: makeQdrant(), embedder, audit });
    await store.purgeProject(TENANT, PROJECT);
    const event = (audit as any).mock.calls[0][0];
    expect(event.action).toBe('memory.project.purge');
    expect(event.projectId).toBe(PROJECT);
  });

  it('fires action=memory.user.purge with userId from purgeUser', async () => {
    const audit = jest.fn<(e: unknown) => void>().mockReturnValue(undefined);
    const store = new QdrantSemanticStore({ qdrant: makeQdrant(), embedder, audit });
    await store.purgeUser(TENANT, USER);
    const event = (audit as any).mock.calls[0][0];
    expect(event.action).toBe('memory.user.purge');
    expect(event.userId).toBe(USER);
  });

  it('fires audit even when the underlying delete swallows a "collection missing" error', async () => {
    const audit  = jest.fn<(e: unknown) => void>().mockReturnValue(undefined);
    const qdrant = makeQdrant({
      delete: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('not found')),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder, audit });
    await store.purgeTenant(TENANT);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('does NOT undo the purge if the auditor itself throws', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const audit  = jest.fn<(e: unknown) => void | Promise<void>>().mockImplementation(() => { throw new Error('audit DB down'); });
    const qdrant = makeQdrant();
    const store = new QdrantSemanticStore({ qdrant, embedder, audit });
    await expect(store.purgeTenant(TENANT)).resolves.toBeUndefined();
    expect(qdrant.delete).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('purge audit hook threw'), expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('QdrantSemanticStore — circuit breaker integration', () => {
  it('does NOT fire the audit when the breaker is open (purge did not happen)', async () => {
    const breaker = new MemoryCircuitBreaker('test', { failureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordFailure(); // trip immediately
    const audit  = jest.fn<(e: unknown) => void>().mockReturnValue(undefined);
    const store  = new QdrantSemanticStore({ qdrant: makeQdrant(), embedder, breaker, audit });

    await expect(store.purgeTenant(TENANT)).rejects.toBeInstanceOf(MemoryCircuitOpenError);
    expect(audit).not.toHaveBeenCalled();
  });

  it('opens the breaker after N consecutive Qdrant failures (full outage)', async () => {
    const breaker = new MemoryCircuitBreaker('test', { failureThreshold: 2, cooldownMs: 60_000 });
    // Simulate a real Qdrant outage: every call fails. The breaker only
    // counts truly-consecutive failures (success on any call resets), so
    // anything less than a full outage stays under the threshold.
    const outage = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('qdrant down'));
    const qdrant = {
      getCollection:    outage,
      createCollection: outage,
      upsert:           outage,
      search:           outage,
      delete:           outage,
      retrieve:         outage,
      setPayload:       outage,
    };
    const store = new QdrantSemanticStore({ qdrant: qdrant as any, embedder, breaker });

    // Two failed delete calls → 2 consecutive failures → breaker opens
    await expect(store.purgeTenant(TENANT)).resolves.toBeUndefined(); // catches non-circuit error
    await expect(store.purgeTenant(TENANT)).resolves.toBeUndefined();
    expect(breaker.getState()).toBe('open');

    // Third call: fast-fails with circuit-open
    await expect(store.purgeTenant(TENANT)).rejects.toBeInstanceOf(MemoryCircuitOpenError);
  });

  it('recall propagates MemoryCircuitOpenError instead of returning []', async () => {
    const breaker = new MemoryCircuitBreaker('test', { failureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordFailure();
    const store = new QdrantSemanticStore({ qdrant: makeQdrant(), embedder, breaker });

    await expect(store.recall({ tenantId: TENANT, query: 'x' }))
      .rejects.toBeInstanceOf(MemoryCircuitOpenError);
  });

  it('recall still returns [] for a missing collection when the breaker is healthy', async () => {
    const breaker = new MemoryCircuitBreaker('test', { failureThreshold: 5, cooldownMs: 60_000 });
    const qdrant  = makeQdrant({
      search: jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('not found')),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder, breaker });

    const results = await store.recall({ tenantId: TENANT, query: 'x' });
    expect(results).toEqual([]);
    // The non-circuit failure WAS recorded; ensure breaker counted it
    expect(breaker.getState()).toBe('closed'); // 1 failure < threshold 5
  });
});
