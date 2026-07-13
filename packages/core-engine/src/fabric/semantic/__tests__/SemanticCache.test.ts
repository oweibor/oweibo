/**
 * K.5 — SemanticCache correctness suite (arms ADR-001 §3.6). The exit-gate
 * heart: cross-identity hits are impossible BY KEY DERIVATION (INV-13, not a
 * post-filter), Critical is never cached (INV-3), event invalidation drops
 * contributing entries, and heartbeat-silence SUSPENDS (not deletes) an entry
 * whose connector has gone quiet (§7.7 / §6.6 mirror).
 */
import { describe, it, expect } from '@jest/globals';
import { SemanticCache } from '../SemanticCache.js';
import type { CacheKeyInput } from '../../planner/contract.js';

const now = 1_000_000_000_000;

function keyFor(identity: string): CacheKeyInput {
  return { tenantId: 't1', canonicalIdentity: identity, policyVersion: 'v1', intentEmbeddingRef: 'pto-emb' };
}

function put(cache: SemanticCache, identity: string, over: Partial<Parameters<SemanticCache['put']>[0]> = {}): boolean {
  return cache.put({
    keyInput: keyFor(identity),
    payload: { answer: `for ${identity}` },
    strictestClass: 'operational',
    contributingDocumentIds: ['doc-pto'],
    contributingGroupRefs: ['eng@acme.test'],
    contributingConnectors: [{ connectorId: 'google-drive', heartbeatSeconds: 300 }],
    nowMs: now,
    ...over,
  });
}

const liveHeartbeat = { connectorLastHeartbeatMs: { 'google-drive': now }, nowMs: now };

describe('SemanticCache — INV-13 cross-identity impossibility (by key derivation)', () => {
  it('a hit for alice is NEVER served to bob (different key)', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    expect(cache.get(keyFor('alice@acme.test'), liveHeartbeat).status).toBe('hit');
    const bob = cache.get(keyFor('bob@acme.test'), liveHeartbeat);
    expect(bob.status).toBe('miss'); // structural — bob's key was never written
  });

  it('the same identity + query + policy hits', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    const hit = cache.get(keyFor('alice@acme.test'), liveHeartbeat);
    expect(hit.status).toBe('hit');
    if (hit.status === 'hit') expect(hit.payload).toEqual({ answer: 'for alice@acme.test' });
  });

  it('a policy-version change misses (stale policy never served)', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    const newPolicy = { ...keyFor('alice@acme.test'), policyVersion: 'v2' };
    expect(cache.get(newPolicy, liveHeartbeat).status).toBe('miss');
  });
});

describe('SemanticCache — INV-3 Critical is never cached', () => {
  it('put refuses a Critical-class result', () => {
    const cache = new SemanticCache();
    const stored = put(cache, 'alice@acme.test', { strictestClass: 'critical' });
    expect(stored).toBe(false);
    expect(cache.get(keyFor('alice@acme.test'), liveHeartbeat).status).toBe('miss');
    expect(cache.size()).toBe(0);
  });
});

describe('SemanticCache — event invalidation (§7.7)', () => {
  it('IndexUpdated/ACLUpdated on a contributing doc drops the entry', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    const dropped = cache.invalidate({ subject: 'ACLUpdated', documentId: 'doc-pto' });
    expect(dropped).toBe(1);
    expect(cache.get(keyFor('alice@acme.test'), liveHeartbeat).status).toBe('miss');
  });

  it('MembershipChanged on a contributing group drops the entry', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    const dropped = cache.invalidate({ subject: 'MembershipChanged', affectedGroupRefs: ['eng@acme.test'] });
    expect(dropped).toBe(1);
  });

  it('an unrelated document/group does not invalidate', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    expect(cache.invalidate({ subject: 'IndexUpdated', documentId: 'other-doc' })).toBe(0);
    expect(cache.invalidate({ subject: 'MembershipChanged', affectedGroupRefs: ['sales@acme.test'] })).toBe(0);
    expect(cache.get(keyFor('alice@acme.test'), liveHeartbeat).status).toBe('hit');
  });
});

describe('SemanticCache — heartbeat-silence suspension (§7.7 / §6.6 mirror)', () => {
  it('suspends (not deletes) when a contributing connector is silent past heartbeatSeconds', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test'); // heartbeatSeconds 300
    // Last heartbeat was 301s ago → silence exceeds the interval → suspend.
    const silent = cache.get(keyFor('alice@acme.test'), {
      connectorLastHeartbeatMs: { 'google-drive': now - 301_000 },
      nowMs: now,
    });
    expect(silent.status).toBe('suspended');
    if (silent.status === 'suspended') expect(silent.connectorId).toBe('google-drive');
    // NOT deleted — once the connector is live again the entry serves.
    expect(cache.size()).toBe(1);
    const live = cache.get(keyFor('alice@acme.test'), {
      connectorLastHeartbeatMs: { 'google-drive': now },
      nowMs: now,
    });
    expect(live.status).toBe('hit');
  });

  it('a never-seen heartbeat is treated as infinite silence → suspend', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test');
    const s = cache.get(keyFor('alice@acme.test'), { connectorLastHeartbeatMs: {}, nowMs: now });
    expect(s.status).toBe('suspended');
  });
});

describe('SemanticCache — TTL by strictest class', () => {
  it('an operational entry expires past its 15-minute TTL', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test'); // operational, written at `now`
    const later = { connectorLastHeartbeatMs: { 'google-drive': now + 16 * 60_000 }, nowMs: now + 16 * 60_000 };
    expect(cache.get(keyFor('alice@acme.test'), later).status).toBe('miss');
  });

  it('a static entry does not expire', () => {
    const cache = new SemanticCache();
    put(cache, 'alice@acme.test', { strictestClass: 'static' });
    const wayLater = { connectorLastHeartbeatMs: { 'google-drive': now + 3.156e10 }, nowMs: now + 3.156e10 }; // ~1yr
    expect(cache.get(keyFor('alice@acme.test'), wayLater).status).toBe('hit');
  });
});
