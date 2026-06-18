/**
 * T.2.f — CredentialResolver tests: TTL cache, fail-closed, LRU bound.
 */
import { CredentialResolver, type IVaultClient } from '../CredentialResolver.js';

function makeVault(rows: Record<string, Record<string, unknown> | null>): {
  vault: IVaultClient;
  reads: string[];
} {
  const reads: string[] = [];
  const vault: IVaultClient = {
    read: jest.fn().mockImplementation(async (p: string) => {
      reads.push(p);
      const r = rows[p];
      return r === undefined ? null : r;
    }),
  };
  return { vault, reads };
}

describe('CredentialResolver', () => {
  it('fetches and returns credentials', async () => {
    const { vault } = makeVault({ 'oweibo/t/1/slack': { token: 'xoxb-test' } });
    const r = new CredentialResolver(vault);
    const out = await r.forTenantConnector('oweibo/t/1/slack');
    expect(out).toEqual({ token: 'xoxb-test' });
  });

  it('returns null when Vault has no entry (fail-closed)', async () => {
    const { vault } = makeVault({});
    const r = new CredentialResolver(vault);
    expect(await r.forTenantConnector('oweibo/t/1/missing')).toBeNull();
  });

  it('returns null when Vault throws (fail-closed)', async () => {
    const vault: IVaultClient = {
      read: jest.fn().mockRejectedValue(new Error('vault down')),
    };
    const r = new CredentialResolver(vault);
    expect(await r.forTenantConnector('p')).toBeNull();
  });

  it('caches within TTL — second call does not hit Vault', async () => {
    const { vault, reads } = makeVault({ 'p': { x: 1 } });
    const r = new CredentialResolver(vault, { ttlMs: 1000, now: () => 1000 });
    await r.forTenantConnector('p');
    await r.forTenantConnector('p');
    expect(reads).toHaveLength(1);
  });

  it('re-fetches after TTL expires', async () => {
    const { vault, reads } = makeVault({ 'p': { x: 1 } });
    let t = 0;
    const r = new CredentialResolver(vault, { ttlMs: 100, now: () => t });
    t = 0;
    await r.forTenantConnector('p');
    t = 200; // past TTL
    await r.forTenantConnector('p');
    expect(reads).toHaveLength(2);
  });

  it('invalidate() removes the entry from cache', async () => {
    const { vault, reads } = makeVault({ 'p': { x: 1 } });
    const r = new CredentialResolver(vault, { ttlMs: 100_000, now: () => 0 });
    await r.forTenantConnector('p');
    r.invalidate('p');
    await r.forTenantConnector('p');
    expect(reads).toHaveLength(2);
  });

  it('caches null results too (no Vault thrashing on missing path)', async () => {
    const { vault, reads } = makeVault({});
    const r = new CredentialResolver(vault, { ttlMs: 1000, now: () => 0 });
    await r.forTenantConnector('missing');
    await r.forTenantConnector('missing');
    expect(reads).toHaveLength(1);
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const rows: Record<string, { x: number }> = {};
    for (let i = 0; i < 10; i++) rows[`p${i}`] = { x: i };
    const { vault, reads } = makeVault(rows);
    const r = new CredentialResolver(vault, { ttlMs: 1000, maxEntries: 3, now: () => 0 });
    for (let i = 0; i < 5; i++) {
      await r.forTenantConnector(`p${i}`);
    }
    // First 2 should have been evicted. Re-fetching p0 should hit Vault again.
    reads.length = 0;
    await r.forTenantConnector('p0');
    expect(reads).toEqual(['p0']);
  });
});
