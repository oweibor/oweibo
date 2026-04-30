/**
 * Unit tests for QdrantSemanticStore — verify contract behaviour without
 * a live Qdrant instance.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  QdrantSemanticStore,
  SemanticStoreCapExceededError,
  SchemaIncompatibleError,
  LegacySchemaError,
} from '../QdrantSemanticStore.js';
import { MemoryCircuitBreaker, MemoryCircuitOpenError } from '../MemoryCircuitBreaker.js';
import type { StoreMemoryInput, MemoryScope } from '@oweibo/core-contracts';

const SCHEMA_MARKER_ID = '00000000-0000-4000-8000-000000000001';

const TENANT  = 't-1';
const USER    = 'u-1';
const PROJECT = 'p-1';
const SCOPE: MemoryScope = { tenantId: TENANT, userId: USER, projectId: PROJECT };
const COLLECTION = `agent-ltm:${TENANT}`;

/**
 * Default retrieve mock routes by id: returns a valid v1 schema marker for
 * SCHEMA_MARKER_ID (so existing tests don't trigger writeSchemaMarker on
 * every store() call) and [] for any other id. Tests override `retrieve`
 * directly when they need different behaviour (e.g. dedup-hit body fetch
 * or schema mismatch scenarios).
 */
function defaultRetrieve(dim = 8) {
  return jest.fn<(col: string, opts: { ids: string[] }) => Promise<unknown>>()
    .mockImplementation(async (_col, opts) => {
      if (opts?.ids?.[0] === SCHEMA_MARKER_ID) {
        return [{
          id: SCHEMA_MARKER_ID,
          payload: {
            _kind:      'schema_marker',
            version:    'v1',
            vector_dim: dim,
            created_at: '2026-01-01T00:00:00Z',
          },
        }];
      }
      return [];
    });
}

function makeQdrant(overrides: Record<string, any> = {}): any {
  return {
    getCollection:    jest.fn<() => Promise<any>>().mockResolvedValue({ points_count: 0 }),
    createCollection: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    upsert:           jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    search:           jest.fn<() => Promise<any>>().mockResolvedValue([]),
    delete:           jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    retrieve:         defaultRetrieve(),
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
    const store = new QdrantSemanticStore({
      qdrant, embedder,
      config: { maxEntriesPerTenant: 100_000, vectorDimension: 8 },
    });
    await expect(store.store(input())).rejects.toBeInstanceOf(SemanticStoreCapExceededError);
    // Marker writes are excluded — only entry writes count for this assertion
    const entryUpserts = qdrant.upsert.mock.calls.filter(
      (c: any[]) => c[1]?.points?.[0]?.id !== SCHEMA_MARKER_ID,
    );
    expect(entryUpserts).toHaveLength(0);
  });

  it('reinforces an existing entry on dedup hit instead of upserting', async () => {
    const qdrant = makeQdrant({
      search: jest.fn().mockResolvedValue([{ id: 'dup-id' }]),
      // retrieve is hit twice: once for the schema marker, once for the
      // dedup-hit body. Route by id so both lookups get the right payload.
      retrieve: jest.fn().mockImplementation(async (_col: string, opts: { ids: string[] }) => {
        if (opts?.ids?.[0] === SCHEMA_MARKER_ID) {
          return [{ id: SCHEMA_MARKER_ID, payload: {
            _kind: 'schema_marker', version: 'v1', vector_dim: 8,
            created_at: '2026-01-01T00:00:00Z',
          }}];
        }
        return [{
          id: 'dup-id',
          payload: {
            tenant_id: TENANT, user_id: USER, project_id: PROJECT,
            kind: 'domain-fact', summary: 'a test memory',
            importance: 0.5, recall_count: 7,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
            tags: [],
          },
        }];
      }),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder, config: { vectorDimension: 8 } });

    const entry = await store.store(input());
    expect(entry.id).toBe('dup-id');
    // No entry upsert (only the schema marker write would be possible, and
    // that only fires on fresh creation, which didn't happen here).
    const entryUpserts = qdrant.upsert.mock.calls.filter(
      (c: any[]) => c[1]?.points?.[0]?.id !== SCHEMA_MARKER_ID,
    );
    expect(entryUpserts).toHaveLength(0);
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

describe('QdrantSemanticStore — schema marker (gap #6 + #10)', () => {
  function markerPoint(payload: Record<string, unknown>) {
    return [{ id: SCHEMA_MARKER_ID, payload }];
  }

  it('writes a v1 schema marker when creating a fresh collection', async () => {
    const qdrant = makeQdrant({
      // First call (existence check) rejects — collection doesn't exist;
      // second call (cap check, AFTER creation) returns a healthy stat.
      getCollection: jest.fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValue({ points_count: 0 }),
    });
    const store = new QdrantSemanticStore({
      qdrant, embedder, config: { vectorDimension: 8, embedderId: 'test-embedder' },
    });

    await store.store(input());

    // Find the upsert call that wrote the marker
    const markerCall = qdrant.upsert.mock.calls.find((c: any[]) =>
      c[1]?.points?.[0]?.id === SCHEMA_MARKER_ID,
    );
    expect(markerCall).toBeDefined();
    const markerPayload = (markerCall as any)[1].points[0].payload;
    expect(markerPayload._kind).toBe('schema_marker');
    expect(markerPayload.version).toBe('v1');
    expect(markerPayload.vector_dim).toBe(8);
    expect(markerPayload.embedder_id).toBe('test-embedder');
    // createCollection was called on the fresh path
    expect(qdrant.createCollection).toHaveBeenCalledTimes(1);
  });

  it('throws SchemaIncompatibleError when the existing marker has a different vector_dim', async () => {
    const qdrant = makeQdrant({
      retrieve: jest.fn<() => Promise<unknown>>().mockResolvedValue(markerPoint({
        _kind: 'schema_marker', version: 'v1', vector_dim: 1536,
        created_at: '2026-01-01T00:00:00Z',
      })),
    });
    const store = new QdrantSemanticStore({
      qdrant, embedder, config: { vectorDimension: 768 }, // configured 768, but collection is 1536
    });

    await expect(store.store(input())).rejects.toBeInstanceOf(SchemaIncompatibleError);
    await expect(store.store(input())).rejects.toThrow(/vector_dim=1536/);
  });

  it('throws SchemaIncompatibleError when embedder_id differs from existing marker', async () => {
    const qdrant = makeQdrant({
      retrieve: jest.fn<() => Promise<unknown>>().mockResolvedValue(markerPoint({
        _kind: 'schema_marker', version: 'v1', vector_dim: 8,
        embedder_id: 'old-embedder',
        created_at: '2026-01-01T00:00:00Z',
      })),
    });
    const store = new QdrantSemanticStore({
      qdrant, embedder, config: { vectorDimension: 8, embedderId: 'new-embedder' },
    });

    await expect(store.store(input())).rejects.toBeInstanceOf(SchemaIncompatibleError);
    await expect(store.store(input())).rejects.toThrow(/embedder_id='old-embedder'/);
  });

  it('passes through when an existing marker matches the current config', async () => {
    const qdrant = makeQdrant({
      retrieve: jest.fn<() => Promise<unknown>>().mockResolvedValue(markerPoint({
        _kind: 'schema_marker', version: 'v1', vector_dim: 8,
        created_at: '2026-01-01T00:00:00Z',
      })),
    });
    const store = new QdrantSemanticStore({
      qdrant, embedder, config: { vectorDimension: 8 },
    });

    await store.store(input());
    // Upsert was called for the entry; the marker write would only happen on
    // fresh creation, which didn't occur here.
    const markerCall = qdrant.upsert.mock.calls.find((c: any[]) =>
      c[1]?.points?.[0]?.id === SCHEMA_MARKER_ID,
    );
    expect(markerCall).toBeUndefined();
  });

  it('warn-and-continue (default) on a legacy collection with no marker', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const qdrant = makeQdrant({
      // retrieve returns no marker → legacy collection
      retrieve: jest.fn<() => Promise<unknown>>().mockResolvedValue([]),
    });
    const store = new QdrantSemanticStore({
      qdrant, embedder, config: { vectorDimension: 8 }, // strictSchema not set
    });

    await expect(store.store(input())).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no schema marker'));
    // It should also have written a marker on-the-fly
    const markerCall = qdrant.upsert.mock.calls.find((c: any[]) =>
      c[1]?.points?.[0]?.id === SCHEMA_MARKER_ID,
    );
    expect(markerCall).toBeDefined();
    warnSpy.mockRestore();
  });

  it('throws LegacySchemaError under strictSchema on a collection with no marker', async () => {
    const qdrant = makeQdrant({
      retrieve: jest.fn<() => Promise<unknown>>().mockResolvedValue([]),
    });
    const store = new QdrantSemanticStore({
      qdrant, embedder, config: { vectorDimension: 8, strictSchema: true },
    });

    await expect(store.store(input())).rejects.toBeInstanceOf(LegacySchemaError);
    await expect(store.store(input())).rejects.toThrow(/no schema marker/);
  });

  it('schema marker is filtered out of recall results (no tenant_id field)', async () => {
    // The store's recall filters by tenant_id; the marker has no tenant_id,
    // so even without an explicit must_not, it's already excluded.
    const qdrant = makeQdrant({
      search: jest.fn<() => Promise<unknown>>().mockResolvedValue([
        // Legitimate result
        { id: 'real-1', score: 0.9, payload: {
          tenant_id: TENANT, kind: 'domain-fact', summary: 'real',
          importance: 0.5, recall_count: 0,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }},
      ]),
    });
    const store = new QdrantSemanticStore({ qdrant, embedder, config: { vectorDimension: 8 } });
    const results = await store.recall({ tenantId: TENANT, query: 'x' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('real-1');

    // The recall filter must include tenant_id
    const [, body] = qdrant.search.mock.calls[0];
    expect(body.filter.must).toContainEqual({ key: 'tenant_id', match: { value: TENANT } });
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
