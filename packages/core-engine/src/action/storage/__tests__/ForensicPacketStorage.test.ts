/**
 * Unit tests for FilesystemForensicPacketStorage and S3ForensicPacketStorage.
 *
 * Filesystem impl runs against a temp directory created per test.
 * S3 impl runs against an in-memory stub of S3Client — no live AWS calls.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FilesystemForensicPacketStorage,
  S3ForensicPacketStorage,
  PacketTooLargeError,
  PacketNotFoundError,
  PACKET_MAX_BYTES,
  resolveForensicStorageFromEnv,
} from '../ForensicPacketStorage.js';
import {
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  NotFound,
  NoSuchKey,
} from '@aws-sdk/client-s3';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const PACKET_1 = 'pkt-aaaa1111';
const PACKET_2 = 'pkt-bbbb2222';

// ── Filesystem ───────────────────────────────────────────────────────────

describe('FilesystemForensicPacketStorage', () => {
  let rootDir: string;
  let store: FilesystemForensicPacketStorage;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forensic-fs-'));
    store = new FilesystemForensicPacketStorage({ rootDir });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('put then get round-trips identical bytes', async () => {
    const body = Buffer.from(JSON.stringify({ goal: 'ship', actions: [] }));
    const { storageRef } = await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: body });
    expect(storageRef).toMatch(/^file:\/\//);
    const fetched = await store.get(storageRef);
    expect(fetched.equals(body)).toBe(true);
  });

  it('put is idempotent — same (tenantId, packetId) twice produces one file', async () => {
    const body = Buffer.from('first');
    await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: body });
    // Second put with different bytes must NOT overwrite (contract: storage is append-only)
    await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: Buffer.from('second') });
    const file = path.join(rootDir, TENANT_A, `${PACKET_1}.json`);
    const onDisk = await fs.readFile(file);
    expect(onDisk.equals(body)).toBe(true);
  });

  it('put rejects bodies larger than the cap', async () => {
    const oversized = Buffer.alloc(PACKET_MAX_BYTES + 1);
    await expect(
      store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: oversized }),
    ).rejects.toBeInstanceOf(PacketTooLargeError);
  });

  it('put rejects invalid tenantId', async () => {
    await expect(
      store.put({ tenantId: 'not-a-uuid', packetId: PACKET_1, bytes: Buffer.alloc(1) }),
    ).rejects.toThrow(/invalid tenantId/);
  });

  it('put rejects packetId with path-traversal characters', async () => {
    await expect(
      store.put({ tenantId: TENANT_A, packetId: '../../etc/passwd', bytes: Buffer.alloc(1) }),
    ).rejects.toThrow(/invalid packetId/);
  });

  it('get throws PacketNotFoundError for an unknown ref', async () => {
    await expect(store.get(`file://${TENANT_A}/${PACKET_2}.json`)).rejects.toBeInstanceOf(PacketNotFoundError);
  });

  it('get rejects refs without the file:// prefix', async () => {
    await expect(store.get(`s3://nope/whatever`)).rejects.toThrow(/not a file/);
  });

  it('get rejects refs containing traversal', async () => {
    await expect(store.get(`file://${TENANT_A}/../escape.json`)).rejects.toThrow(/traversal/);
  });

  it('different (tenantId, packetId) writes do not collide', async () => {
    await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: Buffer.from('a') });
    await store.put({ tenantId: TENANT_A, packetId: PACKET_2, bytes: Buffer.from('b') });
    const a = await store.get(`file://${TENANT_A}/${PACKET_1}.json`);
    const b = await store.get(`file://${TENANT_A}/${PACKET_2}.json`);
    expect(a.toString()).toBe('a');
    expect(b.toString()).toBe('b');
  });
});

// ── S3 ───────────────────────────────────────────────────────────────────

/**
 * In-memory S3Client stub.  Tracks `Bucket/Key -> Buffer`; emits the same
 * 404 errors the real client would for missing objects.
 */
class FakeS3 {
  public store = new Map<string, Buffer>();
  public puts = 0;
  public heads = 0;
  public gets = 0;

  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof HeadObjectCommand) {
      this.heads++;
      const key = `${cmd.input.Bucket}/${cmd.input.Key}`;
      if (!this.store.has(key)) throw new NotFound({ message: '', $metadata: {} });
      return {};
    }
    if (cmd instanceof PutObjectCommand) {
      this.puts++;
      const key = `${cmd.input.Bucket}/${cmd.input.Key}`;
      const body = cmd.input.Body;
      if (!(body instanceof Buffer)) {
        throw new Error(`fake-s3: PutObject Body must be a Buffer; got ${typeof body}`);
      }
      this.store.set(key, body);
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      this.gets++;
      const key = `${cmd.input.Bucket}/${cmd.input.Key}`;
      const bytes = this.store.get(key);
      if (!bytes) throw new NoSuchKey({ message: '', $metadata: {} });
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(bytes),
        },
      };
    }
    throw new Error(`fake-s3: unsupported command ${(cmd as { constructor: { name: string } }).constructor.name}`);
  }
}

describe('S3ForensicPacketStorage', () => {
  let fake: FakeS3;
  let store: S3ForensicPacketStorage;
  const bucket = 'oweibo-forensic-test';

  beforeEach(() => {
    fake = new FakeS3();
    store = new S3ForensicPacketStorage({
      bucket,
      keyPrefix: 'forensic',
      client: fake as unknown as ConstructorParameters<typeof S3ForensicPacketStorage>[0]['client'],
    });
  });

  it('put then get round-trips identical bytes', async () => {
    const body = Buffer.from(JSON.stringify({ goal: 'ship' }));
    const { storageRef } = await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: body });
    expect(storageRef).toBe(`s3://${bucket}/forensic/${TENANT_A}/${PACKET_1}.json`);
    const fetched = await store.get(storageRef);
    expect(fetched.equals(body)).toBe(true);
  });

  it('put uses server-side encryption', async () => {
    let captured: PutObjectCommand | null = null;
    const captureFake = new FakeS3();
    const originalSend = captureFake.send.bind(captureFake);
    captureFake.send = async (cmd: unknown): Promise<unknown> => {
      if (cmd instanceof PutObjectCommand) captured = cmd;
      return originalSend(cmd);
    };
    const captured_store = new S3ForensicPacketStorage({
      bucket,
      client: captureFake as unknown as ConstructorParameters<typeof S3ForensicPacketStorage>[0]['client'],
    });
    await captured_store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: Buffer.from('x') });
    expect(captured).not.toBeNull();
    expect(captured!.input.ServerSideEncryption).toBe('AES256');
  });

  it('put is idempotent — second put for same key does not call PutObject', async () => {
    await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: Buffer.from('first') });
    expect(fake.puts).toBe(1);
    await store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: Buffer.from('second') });
    expect(fake.puts).toBe(1);  // no new write
    const fetched = await store.get(`s3://${bucket}/forensic/${TENANT_A}/${PACKET_1}.json`);
    expect(fetched.toString()).toBe('first');
  });

  it('put rejects bodies larger than the cap', async () => {
    const oversized = Buffer.alloc(PACKET_MAX_BYTES + 1);
    await expect(
      store.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: oversized }),
    ).rejects.toBeInstanceOf(PacketTooLargeError);
  });

  it('get throws PacketNotFoundError for an unknown ref', async () => {
    await expect(
      store.get(`s3://${bucket}/forensic/${TENANT_A}/${PACKET_2}.json`),
    ).rejects.toBeInstanceOf(PacketNotFoundError);
  });

  it('get rejects refs from a different bucket', async () => {
    await expect(
      store.get(`s3://other-bucket/forensic/${TENANT_A}/${PACKET_1}.json`),
    ).rejects.toThrow(/bucket does not match/);
  });

  it('custom keyPrefix is honoured', async () => {
    const customStore = new S3ForensicPacketStorage({
      bucket,
      keyPrefix: 'prod/forensic',
      client: fake as unknown as ConstructorParameters<typeof S3ForensicPacketStorage>[0]['client'],
    });
    const { storageRef } = await customStore.put({ tenantId: TENANT_A, packetId: PACKET_1, bytes: Buffer.from('y') });
    expect(storageRef).toBe(`s3://${bucket}/prod/forensic/${TENANT_A}/${PACKET_1}.json`);
  });
});

// ── Env factory ──────────────────────────────────────────────────────────

describe('resolveForensicStorageFromEnv', () => {
  it('defaults to filesystem', () => {
    const result = resolveForensicStorageFromEnv({});
    expect(result).toBeInstanceOf(FilesystemForensicPacketStorage);
  });

  it('returns undefined for kind=none', () => {
    const result = resolveForensicStorageFromEnv({ OWEIBO_FORENSIC_STORAGE_KIND: 'none' });
    expect(result).toBeUndefined();
  });

  it('requires bucket for kind=s3', () => {
    expect(() =>
      resolveForensicStorageFromEnv({ OWEIBO_FORENSIC_STORAGE_KIND: 's3' }),
    ).toThrow(/OWEIBO_FORENSIC_S3_BUCKET/);
  });

  it('constructs S3 backend when bucket is present', () => {
    const result = resolveForensicStorageFromEnv({
      OWEIBO_FORENSIC_STORAGE_KIND: 's3',
      OWEIBO_FORENSIC_S3_BUCKET: 'b',
      OWEIBO_FORENSIC_S3_REGION: 'eu-west-2',
    });
    expect(result).toBeInstanceOf(S3ForensicPacketStorage);
  });

  it('throws on unknown kind', () => {
    expect(() =>
      resolveForensicStorageFromEnv({ OWEIBO_FORENSIC_STORAGE_KIND: 'gcs' }),
    ).toThrow(/unsupported/);
  });
});
