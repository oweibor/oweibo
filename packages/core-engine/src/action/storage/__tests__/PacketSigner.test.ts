/**
 * Unit tests for HmacPacketSigner.
 *
 * Covers: sign format, round-trip, rejection of malformed signatures,
 * key rotation (verify accepts primary AND next), construction guards,
 * and the SecretsManager-backed factory.
 */
import { randomBytes } from 'crypto';
import {
  HmacPacketSigner,
  hmacPacketSignerFromSecrets,
} from '../PacketSigner.js';

function key(): Buffer {
  return randomBytes(32);
}

describe('HmacPacketSigner — construction', () => {
  it('throws when primary key is missing', () => {
    expect(() => new HmacPacketSigner({ primary: Buffer.alloc(0) })).toThrow(/primary key required/);
  });

  it('throws when primary key is too short', () => {
    expect(() => new HmacPacketSigner({ primary: Buffer.alloc(8) })).toThrow(/primary key too short/);
  });

  it('throws when next key is non-empty but too short', () => {
    expect(() => new HmacPacketSigner({ primary: key(), next: Buffer.alloc(4) })).toThrow(/next key too short/);
  });

  it('accepts construction with primary only', () => {
    expect(() => new HmacPacketSigner({ primary: key() })).not.toThrow();
  });

  it('accepts construction with primary + next', () => {
    expect(() => new HmacPacketSigner({ primary: key(), next: key() })).not.toThrow();
  });

  it('treats empty next buffer as absent (no error)', () => {
    expect(() => new HmacPacketSigner({ primary: key(), next: Buffer.alloc(0) })).not.toThrow();
  });
});

describe('HmacPacketSigner — sign + verify round-trip', () => {
  it('signs with v1: prefix and 64 hex chars', async () => {
    const signer = new HmacPacketSigner({ primary: key() });
    const sig = await signer.sign(Buffer.from('hello'));
    expect(sig.startsWith('v1:')).toBe(true);
    expect(sig.slice(3)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verify returns true for a signature it just produced', async () => {
    const signer = new HmacPacketSigner({ primary: key() });
    const body = Buffer.from(JSON.stringify({ goal: 'ship', t: 1234 }));
    const sig = await signer.sign(body);
    expect(await signer.verify(body, sig)).toBe(true);
  });

  it('verify returns false when the body is tampered', async () => {
    const signer = new HmacPacketSigner({ primary: key() });
    const sig = await signer.sign(Buffer.from('original'));
    expect(await signer.verify(Buffer.from('tampered'), sig)).toBe(false);
  });

  it('verify returns false when the signature is tampered (one bit flip)', async () => {
    const signer = new HmacPacketSigner({ primary: key() });
    const body = Buffer.from('payload');
    const sig = await signer.sign(body);
    const flipped = `v1:${(parseInt(sig.charAt(3), 16) ^ 0x1).toString(16)}${sig.slice(4)}`;
    expect(await signer.verify(body, flipped)).toBe(false);
  });

  it('verify returns false when signed by a different key', async () => {
    const a = new HmacPacketSigner({ primary: key() });
    const b = new HmacPacketSigner({ primary: key() });
    const sig = await a.sign(Buffer.from('x'));
    expect(await b.verify(Buffer.from('x'), sig)).toBe(false);
  });
});

describe('HmacPacketSigner — signature format guards', () => {
  const signer = new HmacPacketSigner({ primary: key() });

  it('rejects a signature without v1: prefix', async () => {
    const sig = (await signer.sign(Buffer.from('x'))).slice(3);
    expect(await signer.verify(Buffer.from('x'), sig)).toBe(false);
  });

  it('rejects a signature with v2: prefix', async () => {
    const raw = (await signer.sign(Buffer.from('x'))).slice(3);
    expect(await signer.verify(Buffer.from('x'), `v2:${raw}`)).toBe(false);
  });

  it('rejects a signature with non-hex chars', async () => {
    expect(await signer.verify(Buffer.from('x'), `v1:zzzz${'0'.repeat(60)}`)).toBe(false);
  });

  it('rejects a signature of wrong length', async () => {
    expect(await signer.verify(Buffer.from('x'), 'v1:abcd')).toBe(false);
  });

  it('rejects an empty signature', async () => {
    expect(await signer.verify(Buffer.from('x'), '')).toBe(false);
  });
});

describe('HmacPacketSigner — key rotation', () => {
  it('verify accepts a signature produced under the next key', async () => {
    const K1 = key();
    const K2 = key();
    // Before rotation: K1 signs.
    const before = new HmacPacketSigner({ primary: K1 });
    const sig = await before.sign(Buffer.from('payload'));

    // Mid-rotation: primary=K2 (now signs new packets), next=K1 (still verifies old packets).
    const mid = new HmacPacketSigner({ primary: K2, next: K1 });
    expect(await mid.verify(Buffer.from('payload'), sig)).toBe(true);

    // New packets signed by mid are verified by mid via primary.
    const newSig = await mid.sign(Buffer.from('new'));
    expect(await mid.verify(Buffer.from('new'), newSig)).toBe(true);

    // After rotation completes (next dropped): K2 alone still verifies the new sig.
    const after = new HmacPacketSigner({ primary: K2 });
    expect(await after.verify(Buffer.from('new'), newSig)).toBe(true);
    // But cannot verify the old sig.
    expect(await after.verify(Buffer.from('payload'), sig)).toBe(false);
  });

  it('sign always uses primary even when next is set', async () => {
    const K1 = key();
    const K2 = key();
    const signer = new HmacPacketSigner({ primary: K1, next: K2 });
    const onlyPrimary = new HmacPacketSigner({ primary: K1 });
    const onlyNext = new HmacPacketSigner({ primary: K2 });

    const sig = await signer.sign(Buffer.from('hi'));
    expect(await onlyPrimary.verify(Buffer.from('hi'), sig)).toBe(true);
    expect(await onlyNext.verify(Buffer.from('hi'), sig)).toBe(false);
  });
});

// ── Factory ──────────────────────────────────────────────────────────────

class FakeSecrets {
  constructor(private readonly payload: Record<string, unknown> | null) {}
  async getInfraCredentials(_name?: string): Promise<unknown> { return this.payload; }
  // The rest of ISecretsManager — not used by the factory.
  async getLangfuseCredentials(): Promise<unknown> { return null; }
  async getExportSigningKey(): Promise<unknown> { return null; }
  async getDatabaseCredentials(): Promise<unknown> { return null; }
  async getLLMApiKey(_p?: string): Promise<unknown> { return null; }
  async getSecret(_p: string): Promise<string> { return ''; }
  async getSecretOrNull(_p: string): Promise<string | null> { return null; }
  async putSecret(_p: string, _v: string): Promise<void> { /* no-op */ }
}

function asSecretsManager(fake: FakeSecrets): import('../../../secrets/SecretsManager.js').SecretsManager {
  return fake as unknown as import('../../../secrets/SecretsManager.js').SecretsManager;
}

describe('hmacPacketSignerFromSecrets', () => {
  it('throws when infra/forensic-signer is missing', async () => {
    await expect(
      hmacPacketSignerFromSecrets(asSecretsManager(new FakeSecrets(null))),
    ).rejects.toThrow(/infra\/forensic-signer not found/);
  });

  it('throws when FORENSIC_SIGNING_KEY is absent', async () => {
    await expect(
      hmacPacketSignerFromSecrets(asSecretsManager(new FakeSecrets({}))),
    ).rejects.toThrow(/FORENSIC_SIGNING_KEY/);
  });

  it('throws when FORENSIC_SIGNING_KEY decodes to zero bytes', async () => {
    await expect(
      hmacPacketSignerFromSecrets(asSecretsManager(new FakeSecrets({ FORENSIC_SIGNING_KEY: '' }))),
    ).rejects.toThrow(/FORENSIC_SIGNING_KEY/);
  });

  it('constructs a signer from a base64 primary', async () => {
    const k = randomBytes(32).toString('base64');
    const signer = await hmacPacketSignerFromSecrets(
      asSecretsManager(new FakeSecrets({ FORENSIC_SIGNING_KEY: k })),
    );
    const sig = await signer.sign(Buffer.from('x'));
    expect(await signer.verify(Buffer.from('x'), sig)).toBe(true);
  });

  it('constructs a signer with both primary and next keys', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const signer = await hmacPacketSignerFromSecrets(
      asSecretsManager(new FakeSecrets({
        FORENSIC_SIGNING_KEY:      k1.toString('base64'),
        FORENSIC_SIGNING_KEY_NEXT: k2.toString('base64'),
      })),
    );
    // Signature produced by a signer with primary=k2 should verify under
    // this signer (k2 is next).
    const k2signer = new HmacPacketSigner({ primary: k2 });
    const sig = await k2signer.sign(Buffer.from('rotated'));
    expect(await signer.verify(Buffer.from('rotated'), sig)).toBe(true);
  });
});
