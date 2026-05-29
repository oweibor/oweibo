/**
 * Unit tests for HmacSnapshotVerifier + HmacSnapshotSigner.
 *
 * Covers construction guards, canonical-form determinism, signer/verifier
 * round-trip, tamper detection on every field, key rotation, anti-replay
 * (snapshotAt age cap), signature format guards, and the SecretsManager-
 * backed factory.
 */
import { randomBytes } from 'crypto';
import type { TenantReadinessSnapshot } from '@oweibo/core-contracts';
import {
  HmacSnapshotSigner,
  HmacSnapshotVerifier,
  canonicalizeSnapshotForSigning,
  hmacSnapshotSignerFromSecrets,
  hmacSnapshotVerifierFromSecrets,
  loadHmacSnapshotKeys,
} from '../HmacSnapshotVerifier.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function key(): Buffer {
  return randomBytes(32);
}

function snapshotBase(): Omit<TenantReadinessSnapshot, 'sourceSig'> {
  return {
    tenantId: TENANT,
    accountAgeDays: 42,
    actionClassScores: { 'deploy.prod.kube': 0.85, 'comm.external_email': 0.95 },
    snapshotAt: '2026-05-29T12:00:00.000Z',
  };
}

function sign(signer: HmacSnapshotSigner, base = snapshotBase()): TenantReadinessSnapshot {
  return { ...base, sourceSig: signer.sign(base) };
}

describe('HmacSnapshotVerifier — construction', () => {
  it('throws when primary key is missing', () => {
    expect(() => new HmacSnapshotVerifier({ primary: Buffer.alloc(0) })).toThrow(/primary key required/);
  });

  it('throws when primary key is too short', () => {
    expect(() => new HmacSnapshotVerifier({ primary: Buffer.alloc(8) })).toThrow(/primary key too short/);
  });

  it('throws when next key is non-empty but too short', () => {
    expect(() => new HmacSnapshotVerifier({ primary: key(), next: Buffer.alloc(4) })).toThrow(/next key too short/);
  });

  it('treats empty next buffer as absent (no error)', () => {
    expect(() => new HmacSnapshotVerifier({ primary: key(), next: Buffer.alloc(0) })).not.toThrow();
  });
});

describe('canonicalizeSnapshotForSigning', () => {
  it('emits sorted keys + no whitespace and drops sourceSig', () => {
    const base = snapshotBase();
    const c = canonicalizeSnapshotForSigning(base);
    expect(c).toBe(
      '{"accountAgeDays":42,' +
      '"actionClassScores":{"comm.external_email":0.95,"deploy.prod.kube":0.85},' +
      `"snapshotAt":"${base.snapshotAt}",` +
      `"tenantId":"${TENANT}"}`,
    );
  });

  it('is order-independent for the input object', () => {
    const a = canonicalizeSnapshotForSigning(snapshotBase());
    // Insert keys in opposite order — canonical form must be identical.
    const reordered: Omit<TenantReadinessSnapshot, 'sourceSig'> = {
      snapshotAt: snapshotBase().snapshotAt,
      tenantId: TENANT,
      actionClassScores: { 'deploy.prod.kube': 0.85, 'comm.external_email': 0.95 },
      accountAgeDays: 42,
    };
    expect(canonicalizeSnapshotForSigning(reordered)).toBe(a);
  });
});

describe('HmacSnapshotVerifier — round-trip', () => {
  it('verify accepts a freshly-signed snapshot', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, { skipStalenessCheck: true });
    expect(verifier.verify(sign(signer))).toBe(true);
  });

  it('verify rejects when tenantId is tampered', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, { skipStalenessCheck: true });
    const s = sign(signer);
    expect(verifier.verify({ ...s, tenantId: '22222222-2222-2222-2222-222222222222' })).toBe(false);
  });

  it('verify rejects when accountAgeDays is tampered', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, { skipStalenessCheck: true });
    const s = sign(signer);
    expect(verifier.verify({ ...s, accountAgeDays: 999 })).toBe(false);
  });

  it('verify rejects when actionClassScores is tampered', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, { skipStalenessCheck: true });
    const s = sign(signer);
    expect(verifier.verify({ ...s, actionClassScores: { 'deploy.prod.kube': 1.0 } })).toBe(false);
  });

  it('verify rejects when signed by a different key', () => {
    const signer = new HmacSnapshotSigner({ primary: key() });
    const verifier = new HmacSnapshotVerifier({ primary: key() }, { skipStalenessCheck: true });
    expect(verifier.verify(sign(signer))).toBe(false);
  });
});

describe('HmacSnapshotVerifier — signature format guards', () => {
  const k = key();
  const verifier = new HmacSnapshotVerifier({ primary: k }, { skipStalenessCheck: true });

  it('rejects non-string sourceSig', () => {
    const s = { ...snapshotBase(), sourceSig: 1234 as unknown as string };
    expect(verifier.verify(s as TenantReadinessSnapshot)).toBe(false);
  });

  it('rejects non-hex sourceSig', () => {
    const s: TenantReadinessSnapshot = { ...snapshotBase(), sourceSig: 'zz' + 'a'.repeat(62) };
    expect(verifier.verify(s)).toBe(false);
  });

  it('rejects sourceSig of wrong length', () => {
    const s: TenantReadinessSnapshot = { ...snapshotBase(), sourceSig: 'abcd' };
    expect(verifier.verify(s)).toBe(false);
  });
});

describe('HmacSnapshotVerifier — anti-replay (snapshotAt cap)', () => {
  it('rejects a snapshot older than maxAgeSeconds when enabled', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, {
      maxAgeSeconds: 60,
      now: () => new Date('2026-05-29T13:00:00Z'),
      env: 'production',  // enable staleness
    });
    const base = { ...snapshotBase(), snapshotAt: '2026-05-29T12:00:00Z' };  // 1h old
    const sig = signer.sign(base);
    expect(verifier.verify({ ...base, sourceSig: sig })).toBe(false);
  });

  it('accepts a fresh snapshot under the cap', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, {
      maxAgeSeconds: 60,
      now: () => new Date('2026-05-29T12:00:30Z'),  // 30s after sign
      env: 'production',
    });
    const base = { ...snapshotBase(), snapshotAt: '2026-05-29T12:00:00Z' };
    const sig = signer.sign(base);
    expect(verifier.verify({ ...base, sourceSig: sig })).toBe(true);
  });

  it('skips staleness check by default in non-production env', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, {
      maxAgeSeconds: 1,
      now: () => new Date('3000-01-01T00:00:00Z'),  // way past the cap
      env: 'development',
    });
    expect(verifier.verify(sign(signer))).toBe(true);
  });

  it('rejects snapshots with a malformed snapshotAt when staleness is enabled', () => {
    const k = key();
    const signer = new HmacSnapshotSigner({ primary: k });
    const verifier = new HmacSnapshotVerifier({ primary: k }, { env: 'production' });
    const s: TenantReadinessSnapshot = { ...snapshotBase(), snapshotAt: 'not-a-date', sourceSig: signer.sign(snapshotBase()) };
    expect(verifier.verify(s)).toBe(false);
  });
});

describe('HmacSnapshotVerifier — key rotation', () => {
  it('verify accepts a signature produced under the next key', () => {
    const K1 = key();
    const K2 = key();
    // Mid-rotation: primary=K2 (now signs), next=K1 (still verifies old).
    const verifier = new HmacSnapshotVerifier({ primary: K2, next: K1 }, { skipStalenessCheck: true });
    // Old signer (still K1) signs.
    const k1signer = new HmacSnapshotSigner({ primary: K1 });
    expect(verifier.verify(sign(k1signer))).toBe(true);
    // New signer (now K2) also verifies.
    const k2signer = new HmacSnapshotSigner({ primary: K2 });
    expect(verifier.verify(sign(k2signer))).toBe(true);
  });

  it('sign uses primary even when next is set', () => {
    const K1 = key();
    const K2 = key();
    const signer = new HmacSnapshotSigner({ primary: K1, next: K2 });
    const onlyPrimary = new HmacSnapshotVerifier({ primary: K1 }, { skipStalenessCheck: true });
    const onlyNext = new HmacSnapshotVerifier({ primary: K2 }, { skipStalenessCheck: true });
    const s = sign(signer);
    expect(onlyPrimary.verify(s)).toBe(true);
    expect(onlyNext.verify(s)).toBe(false);
  });
});

// ── Factory ──────────────────────────────────────────────────────────────

class FakeSecrets {
  constructor(private readonly payload: Record<string, unknown> | null) {}
  async getInfraCredentials(_n?: string): Promise<unknown> { return this.payload; }
  async getLangfuseCredentials(): Promise<unknown> { return null; }
  async getExportSigningKey(): Promise<unknown> { return null; }
  async getDatabaseCredentials(): Promise<unknown> { return null; }
  async getLLMApiKey(_p?: string): Promise<unknown> { return null; }
  async getSecret(_p: string): Promise<string> { return ''; }
  async getSecretOrNull(_p: string): Promise<string | null> { return null; }
  async putSecret(_p: string, _v: string): Promise<void> { /* no-op */ }
}
const asSecretsManager = (f: FakeSecrets) =>
  f as unknown as import('../../secrets/SecretsManager.js').SecretsManager;

describe('Factory: loadHmacSnapshotKeys / hmacSnapshotVerifierFromSecrets', () => {
  it('throws when infra/calibration-signer is missing', async () => {
    await expect(loadHmacSnapshotKeys(asSecretsManager(new FakeSecrets(null))))
      .rejects.toThrow(/infra\/calibration-signer not found/);
  });

  it('throws when CALIBRATION_SIGNING_KEY is absent', async () => {
    await expect(loadHmacSnapshotKeys(asSecretsManager(new FakeSecrets({}))))
      .rejects.toThrow(/CALIBRATION_SIGNING_KEY/);
  });

  it('constructs a verifier from a base64 primary', async () => {
    const k = randomBytes(32).toString('base64');
    const v = await hmacSnapshotVerifierFromSecrets(
      asSecretsManager(new FakeSecrets({ CALIBRATION_SIGNING_KEY: k })),
      { skipStalenessCheck: true },
    );
    const signer = await hmacSnapshotSignerFromSecrets(
      asSecretsManager(new FakeSecrets({ CALIBRATION_SIGNING_KEY: k })),
    );
    expect(v.verify(sign(signer))).toBe(true);
  });

  it('constructs a verifier with both primary and next', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const v = await hmacSnapshotVerifierFromSecrets(
      asSecretsManager(new FakeSecrets({
        CALIBRATION_SIGNING_KEY:      k1.toString('base64'),
        CALIBRATION_SIGNING_KEY_NEXT: k2.toString('base64'),
      })),
      { skipStalenessCheck: true },
    );
    const k2signer = new HmacSnapshotSigner({ primary: k2 });
    expect(v.verify(sign(k2signer))).toBe(true);
  });
});
