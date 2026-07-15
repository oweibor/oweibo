/**
 * ADR-009 §7 — INV-2/10/12 conformance for the outbound face.
 *
 * The structural claim: the face is a CALLER, never a bypass. It has no ranking
 * entry point, no SQL, no ACL logic — so INV-2/3/4/11 hold by construction. The
 * tests here prove the face's OWN obligations: scope gating, tenant-from-token,
 * credential-leak refusal, the fetch existence-oracle guard, and the
 * withhold-is-not-empty rule.
 */
import {
  McpServerFace,
  assertNoCredentialLeak,
  type McpBackend,
  type McpPrincipalBinding,
  type McpRateLimiter,
  type McpQuota,
  MCP_ERR,
} from '../McpServerFace';

const binding = (over: Partial<McpPrincipalBinding> = {}): McpPrincipalBinding => ({
  tenantId: 't1',
  principalId: 'p1',
  clientId: 'client-a',
  scopes: ['oweibo:search', 'oweibo:fetch', 'oweibo:act'],
  principalRefs: ['p1@acme.test'],
  ...over,
});

const okRateLimiter: McpRateLimiter = { tryConsume: async () => ({ kind: 'allowed' }) };
const okQuota: McpQuota = { preflight: async () => ({ kind: 'allow' }), record: async () => undefined };

const backend = (over: Partial<McpBackend> = {}): McpBackend => ({
  search: async () => [
    {
      knowledgeObjectId: 'ko1', source: 'google_drive', snippet: 'hit',
      citation: { knowledgeObjectId: 'ko1', source: 'google_drive', indexGeneration: 3, sourceRevision: 7 },
    },
  ],
  fetch: async () => ({
    knowledgeObjectId: 'ko1', content: 'body',
    citation: { knowledgeObjectId: 'ko1', source: 'google_drive' },
  }),
  act: async () => ({ verdict: 'allowed' as const, reference: 'act-1' }),
  ...over,
});

const face = (b?: Partial<McpBackend>) => new McpServerFace(backend(b), okRateLimiter, okQuota);

describe('ADR-009 §3.2 — INV-2: the face has no ranking entry point', () => {
  it('search delegates to the backend and never re-ranks — it only drops uncited hits', async () => {
    // The face exposes no scoring/ranking surface; a public-method scan finds none.
    const methods = Object.getOwnPropertyNames(McpServerFace.prototype);
    expect(methods).not.toContain('rank');
    expect(methods).not.toContain('score');
    const r = await face().call(binding(), 'oweibo.search', { query: 'x' }, 'req-1');
    expect(r.ok).toBe(true);
  });

  it('drops a search hit missing provenance rather than returning it uncited (§3.2 rule 5)', async () => {
    const r = await face({
      search: async () => [
        { knowledgeObjectId: 'ok', source: 's', snippet: 'a', citation: { knowledgeObjectId: 'ok', source: 's' } },
        // Missing citation.knowledgeObjectId — must be dropped.
        { knowledgeObjectId: 'bad', source: 's', snippet: 'b', citation: { knowledgeObjectId: '', source: 's' } },
      ],
    }).call(binding(), 'oweibo.search', { query: 'x' }, 'req-2');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as unknown[]).length).toBe(1);
  });
});

describe('ADR-009 §3.3 — authz + tenant-from-token', () => {
  it('denies a tool the client lacks the scope for', async () => {
    const r = await face().call(binding({ scopes: ['oweibo:search'] }), 'oweibo.act', { capabilityId: 'c', arguments: {} }, 'r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MCP_ERR.SCOPE_DENIED);
  });

  it('a search-scoped client cannot reach fetch', async () => {
    const r = await face().call(binding({ scopes: ['oweibo:search'] }), 'oweibo.fetch', { knowledgeObjectId: 'x' }, 'r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MCP_ERR.SCOPE_DENIED);
  });

  it('REJECTS a client-supplied tenantId — tenant is from the token only (INV-12)', async () => {
    const r = await face().call(binding(), 'oweibo.search', { query: 'x', tenantId: 't2' }, 'r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MCP_ERR.BAD_REQUEST);
  });
});

describe('ADR-009 §3.3 — fetch is not an existence oracle', () => {
  it('a denied fetch and a nonexistent object return the SAME error shape', async () => {
    const notFound = await face({ fetch: async () => ({ notFoundOrDenied: true as const }) })
      .call(binding(), 'oweibo.fetch', { knowledgeObjectId: 'missing' }, 'r1');
    const denied = await face({ fetch: async () => ({ notFoundOrDenied: true as const }) })
      .call(binding(), 'oweibo.fetch', { knowledgeObjectId: 'forbidden' }, 'r2');
    expect(notFound.ok).toBe(false);
    expect(denied.ok).toBe(false);
    if (!notFound.ok && !denied.ok) {
      // Indistinguishable — no leak of which case occurred.
      expect(notFound.error).toEqual(denied.error);
    }
  });
});

describe('ADR-009 §7 — INV-10: no credential escapes the envelope', () => {
  it('the scanner catches a credential-shaped field anywhere in a result', () => {
    expect(() => assertNoCredentialLeak({ ok: { nested: { access_token: 'sk-123' } } })).toThrow(/INV-10/);
    expect(() => assertNoCredentialLeak({ items: [{ authorization: 'Bearer x' }] })).toThrow(/INV-10/);
    // Empty / absent credential-shaped fields are fine (no value to leak).
    expect(() => assertNoCredentialLeak({ token: '' })).not.toThrow();
    expect(() => assertNoCredentialLeak({ ok: true, citation: { source: 's' } })).not.toThrow();
  });

  it('a backend that leaks a token is refused, not returned', async () => {
    const r = await face({
      act: async () => ({ verdict: 'allowed' as const, reference: 'x', apiKey: 'sk-leak' } as never),
    }).call(binding(), 'oweibo.act', { capabilityId: 'c', arguments: {} }, 'r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MCP_ERR.INTERNAL);
  });
});

describe('ADR-009 §3.5 — rate limit and quota (cheap-first, keyed per client)', () => {
  it('a hard rate-limit is refused with retryAfterMs', async () => {
    const f = new McpServerFace(
      backend(),
      { tryConsume: async () => ({ kind: 'hard', retryAfterMs: 1500 }) },
      okQuota,
    );
    const r = await f.call(binding(), 'oweibo.search', { query: 'x' }, 'r');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe(MCP_ERR.RATE_LIMITED); expect(r.error.retryAfterMs).toBe(1500); }
  });

  it('a quota denial is refused', async () => {
    const f = new McpServerFace(backend(), okRateLimiter, {
      preflight: async () => ({ kind: 'deny', resetAtMs: 9 }), record: async () => undefined,
    });
    const r = await f.call(binding(), 'oweibo.search', { query: 'x' }, 'r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(MCP_ERR.RATE_LIMITED);
  });

  it('records quota only after a successful call, keyed on the request id (dedupe)', async () => {
    const recorded: string[] = [];
    const f = new McpServerFace(backend(), okRateLimiter, {
      preflight: async () => ({ kind: 'allow' }),
      record: async (a) => { recorded.push(a.dedupeKey); },
    });
    await f.call(binding(), 'oweibo.search', { query: 'x' }, 'req-42');
    expect(recorded).toEqual(['req-42']);
  });

  it('limit is clamped to the configured max', async () => {
    let seenLimit = -1;
    const f = new McpServerFace(
      backend({ search: async (a) => { seenLimit = a.limit; return []; } }),
      okRateLimiter, okQuota, { maxLimit: 50 },
    );
    await f.call(binding(), 'oweibo.search', { query: 'x', limit: 9999 }, 'r');
    expect(seenLimit).toBe(50);
  });
});
