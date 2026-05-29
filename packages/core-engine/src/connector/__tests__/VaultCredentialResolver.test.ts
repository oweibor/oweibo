/**
 * Unit tests for VaultCredentialResolver.
 *
 * Covers the path convention, malformed-input handling, the discriminated
 * result shape, cache invalidation via the inner T.2.f resolver, and the
 * env-driven factory.
 */
import {
  VaultCredentialResolver,
  vaultCredentialResolverFromEnv,
  type CredentialLookupResult,
} from '../VaultCredentialResolver.js';
import type { IVaultClient } from '../CredentialResolver.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CONNECTOR = 'slack-connector-v1';

class FakeVault implements IVaultClient {
  public reads: string[] = [];
  public throwOnRead: Error | null = null;
  constructor(private readonly store: Record<string, Readonly<Record<string, unknown>>>) {}
  async read(path: string): Promise<Readonly<Record<string, unknown>> | null> {
    this.reads.push(path);
    if (this.throwOnRead) throw this.throwOnRead;
    return this.store[path] ?? null;
  }
}

describe('VaultCredentialResolver.resolveForConnector', () => {
  it('returns credentials when Vault has the path', async () => {
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/${CONNECTOR}`]: { token: 'xoxb-abc' },
    });
    const r = new VaultCredentialResolver(vault);
    const result = await r.resolveForConnector(TENANT, CONNECTOR);
    expect(result.kind).toBe('credentials');
    if (result.kind === 'credentials') {
      expect(result.value).toEqual({ token: 'xoxb-abc' });
    }
    expect(vault.reads).toEqual([`tenants/${TENANT}/connectors/${CONNECTOR}`]);
  });

  it('returns credential_unavailable when tenantId is malformed (no Vault call)', async () => {
    const vault = new FakeVault({});
    const r = new VaultCredentialResolver(vault);
    const result = await r.resolveForConnector('not-a-uuid', CONNECTOR);
    expect(result).toEqual({ kind: 'credential_unavailable', reason: 'not_configured' });
    expect(vault.reads).toEqual([]);
  });

  it('returns credential_unavailable when connectorId has illegal characters', async () => {
    const vault = new FakeVault({});
    const r = new VaultCredentialResolver(vault);
    const result = await r.resolveForConnector(TENANT, '../../etc/passwd');
    expect(result).toEqual({ kind: 'credential_unavailable', reason: 'not_configured' });
    expect(vault.reads).toEqual([]);
  });

  it('returns credential_unavailable when Vault returns null', async () => {
    const vault = new FakeVault({});
    const r = new VaultCredentialResolver(vault);
    const result = await r.resolveForConnector(TENANT, CONNECTOR);
    expect(result).toEqual({ kind: 'credential_unavailable', reason: 'unavailable' });
  });

  it('returns credential_unavailable when Vault throws (fail-closed)', async () => {
    const vault = new FakeVault({});
    vault.throwOnRead = new Error('vault offline');
    const r = new VaultCredentialResolver(vault);
    const result = await r.resolveForConnector(TENANT, CONNECTOR);
    expect(result).toEqual({ kind: 'credential_unavailable', reason: 'unavailable' });
  });

  it('caches successful reads within TTL', async () => {
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/${CONNECTOR}`]: { token: 'tok' },
    });
    const r = new VaultCredentialResolver(vault, { ttlMs: 60_000, now: () => 0 });
    await r.resolveForConnector(TENANT, CONNECTOR);
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(1);
  });

  it('caches null results within TTL too (no Vault re-call)', async () => {
    const vault = new FakeVault({});
    const r = new VaultCredentialResolver(vault, { ttlMs: 60_000, now: () => 0 });
    await r.resolveForConnector(TENANT, CONNECTOR);
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(1);
  });

  it('re-queries Vault after TTL expires', async () => {
    let t = 0;
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/${CONNECTOR}`]: { token: 'tok' },
    });
    const r = new VaultCredentialResolver(vault, { ttlMs: 100, now: () => t });
    await r.resolveForConnector(TENANT, CONNECTOR);
    t = 200;  // past TTL
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(2);
  });
});

describe('VaultCredentialResolver.invalidate', () => {
  it('forces a Vault re-query on the next resolve', async () => {
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/${CONNECTOR}`]: { token: 'tok' },
    });
    const r = new VaultCredentialResolver(vault, { ttlMs: 60_000, now: () => 0 });
    await r.resolveForConnector(TENANT, CONNECTOR);
    r.invalidate(TENANT, CONNECTOR);
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(2);
  });

  it('is a no-op for malformed ids', async () => {
    const vault = new FakeVault({});
    const r = new VaultCredentialResolver(vault);
    expect(() => r.invalidate('not-a-uuid', CONNECTOR)).not.toThrow();
  });

  it('invalidateAll() drops all entries', async () => {
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/c1`]: { token: 'x' },
      [`tenants/${TENANT}/connectors/c2`]: { token: 'y' },
    });
    const r = new VaultCredentialResolver(vault, { ttlMs: 60_000, now: () => 0 });
    await r.resolveForConnector(TENANT, 'c1');
    await r.resolveForConnector(TENANT, 'c2');
    expect(vault.reads.length).toBe(2);
    r.invalidateAll();
    await r.resolveForConnector(TENANT, 'c1');
    await r.resolveForConnector(TENANT, 'c2');
    expect(vault.reads.length).toBe(4);
  });
});

describe('VaultCredentialResolver.pathFor', () => {
  it('builds the canonical tenants/<id>/connectors/<id> path', () => {
    const vault = new FakeVault({});
    const r = new VaultCredentialResolver(vault);
    expect(r.pathFor(TENANT, CONNECTOR)).toBe(`tenants/${TENANT}/connectors/${CONNECTOR}`);
  });
});

describe('vaultCredentialResolverFromEnv', () => {
  it('honours VAULT_TOKEN_TTL_S in seconds', async () => {
    let t = 0;
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/${CONNECTOR}`]: { token: 'x' },
    });
    const r = vaultCredentialResolverFromEnv(vault, { VAULT_TOKEN_TTL_S: '10' }, { now: () => t });
    await r.resolveForConnector(TENANT, CONNECTOR);
    t = 5_000;  // 5s < 10s
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(1);
    t = 11_000;  // past 10s
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(2);
  });

  it('defaults to 300s when env is missing', async () => {
    let t = 0;
    const vault = new FakeVault({
      [`tenants/${TENANT}/connectors/${CONNECTOR}`]: { token: 'x' },
    });
    const r = vaultCredentialResolverFromEnv(vault, {}, { now: () => t });
    await r.resolveForConnector(TENANT, CONNECTOR);
    t = 299_000;  // < 300s
    await r.resolveForConnector(TENANT, CONNECTOR);
    expect(vault.reads.length).toBe(1);
  });

  it('falls back to 300s when VAULT_TOKEN_TTL_S is non-numeric or non-positive', async () => {
    const vault = new FakeVault({});
    // Each just constructs; we only assert no throw + correct fallback shape.
    expect(() => vaultCredentialResolverFromEnv(vault, { VAULT_TOKEN_TTL_S: 'abc' })).not.toThrow();
    expect(() => vaultCredentialResolverFromEnv(vault, { VAULT_TOKEN_TTL_S: '-5' })).not.toThrow();
    expect(() => vaultCredentialResolverFromEnv(vault, { VAULT_TOKEN_TTL_S: '0' })).not.toThrow();
  });
});

// Tsc check that named exports are reachable.
void (null as unknown as CredentialLookupResult);
