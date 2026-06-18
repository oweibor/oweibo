/**
 * F.1.1 — IForensicPacketStorage implementations.
 *
 * Two impls, selected at composition time via OWEIBO_FORENSIC_STORAGE_KIND:
 *
 *   `filesystem` — FilesystemForensicPacketStorage. Default for dev / single-
 *                  node deploys. Writes to
 *                  `${OWEIBO_FORENSIC_STORAGE_DIR}/<tenantId>/<packetId>.json`.
 *
 *   `s3`         — S3ForensicPacketStorage. Required for multi-replica
 *                  production. Server-side encrypted (SSE-S3). Operator
 *                  applies a bucket lifecycle policy outside this code.
 *
 * Contract notes (per core-contracts/src/action/ForensicPacket.ts):
 *   - Storage is append-only — packets are never overwritten.
 *   - put returns a storage ref that get can round-trip.
 *   - put is idempotent: the same (tenantId, packetId) twice is a no-op,
 *     not an overwrite. Both impls implement this via "if-not-exists" check
 *     before write.
 *
 * Body size cap: 10 MB. Larger packets are rejected at put time with
 * PacketTooLargeError; the builder is responsible for truncation upstream.
 *
 * Concurrency: same (tenantId, packetId) raced from two callers — first
 * writer wins; second sees the existing object and returns the same ref.
 * packetId is computed from a hash of (tenantId, planId, atMs) so true
 * collisions are astronomical; this branch handles the retry-of-same-packet
 * case (worker restart, etc.).
 */
import {
  promises as fs,
  constants as fsConstants,
} from 'fs';
import * as path from 'path';
import type { IForensicPacketStorage } from '@oweibo/core-contracts';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
} from '@aws-sdk/client-s3';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const PACKET_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const PACKET_MAX_BYTES = 10 * 1024 * 1024;

export class PacketTooLargeError extends Error {
  override readonly name = 'PacketTooLargeError';
  constructor(actualBytes: number, readonly maxBytes: number = PACKET_MAX_BYTES) {
    super(`forensic packet body is ${actualBytes} bytes; cap is ${maxBytes}`);
  }
}

export class PacketNotFoundError extends Error {
  override readonly name = 'PacketNotFoundError';
  constructor(readonly storageRef: string) {
    super(`forensic packet not found at ${storageRef}`);
  }
}

function validatePutArgs(args: { tenantId: string; packetId: string; bytes: Buffer }): void {
  if (!UUID_RE.test(args.tenantId)) {
    throw new Error(`forensic-storage put: invalid tenantId ${args.tenantId}`);
  }
  // packetId is hashed; constrain its character set so neither impl needs
  // to deal with path-traversal or S3 key-encoding edge cases.
  if (!PACKET_ID_RE.test(args.packetId)) {
    throw new Error(`forensic-storage put: invalid packetId ${args.packetId}`);
  }
  if (args.bytes.length > PACKET_MAX_BYTES) {
    throw new PacketTooLargeError(args.bytes.length);
  }
}

// ── Filesystem ───────────────────────────────────────────────────────────

export interface FilesystemForensicPacketStorageOptions {
  readonly rootDir: string;
}

export class FilesystemForensicPacketStorage implements IForensicPacketStorage {
  constructor(private readonly opts: FilesystemForensicPacketStorageOptions) {}

  async put(args: { tenantId: string; packetId: string; bytes: Buffer }): Promise<{ storageRef: string }> {
    validatePutArgs(args);
    const dir = path.join(this.opts.rootDir, args.tenantId);
    const file = path.join(dir, `${args.packetId}.json`);
    // Idempotent: if the file is already present, leave it alone. The
    // existence check + write race results in a "last-write-wins" outcome
    // that is acceptable per the contract above (packetId is content-derived).
    try {
      await fs.access(file, fsConstants.F_OK);
      return { storageRef: this.refFor(args.tenantId, args.packetId) };
    } catch { /* file does not exist — write it */ }
    await fs.mkdir(dir, { recursive: true });
    // Use 'wx' so a concurrent put on the same path doesn't overwrite an
    // already-written packet. 'wx' fails with EEXIST when the file exists,
    // which we treat as the idempotent path.
    try {
      await fs.writeFile(file, args.bytes, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { storageRef: this.refFor(args.tenantId, args.packetId) };
  }

  async get(storageRef: string): Promise<Buffer> {
    const file = this.fileForRef(storageRef);
    try {
      return await fs.readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PacketNotFoundError(storageRef);
      }
      throw err;
    }
  }

  private refFor(tenantId: string, packetId: string): string {
    return `file://${tenantId}/${packetId}.json`;
  }

  private fileForRef(storageRef: string): string {
    const prefix = 'file://';
    if (!storageRef.startsWith(prefix)) {
      throw new Error(`filesystem storage get: not a file:// ref (${storageRef})`);
    }
    const rel = storageRef.slice(prefix.length);
    // Defence in depth: refuse traversal even though refs come from put().
    if (rel.includes('..')) {
      throw new Error(`filesystem storage get: traversal in ref (${storageRef})`);
    }
    return path.join(this.opts.rootDir, rel);
  }
}

// ── S3 ───────────────────────────────────────────────────────────────────

export interface S3ForensicPacketStorageOptions {
  readonly bucket: string;
  /** Defaults to 'forensic'. */
  readonly keyPrefix?: string;
  /** Caller-constructed S3Client (lets tests inject a stub). */
  readonly client: S3Client;
}

export class S3ForensicPacketStorage implements IForensicPacketStorage {
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly client: S3Client;

  constructor(opts: S3ForensicPacketStorageOptions) {
    this.bucket = opts.bucket;
    this.keyPrefix = (opts.keyPrefix ?? 'forensic').replace(/\/$/, '');
    this.client = opts.client;
  }

  async put(args: { tenantId: string; packetId: string; bytes: Buffer }): Promise<{ storageRef: string }> {
    validatePutArgs(args);
    const key = this.keyFor(args.tenantId, args.packetId);
    // Idempotent: HEAD first; if the object exists, do not overwrite.
    // (S3 does not yet support `If-None-Match: *` everywhere — HEAD is the
    // portable form.)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { storageRef: this.refFor(key) };
    } catch (err) {
      if (!isS3NotFound(err)) throw err;
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: args.bytes,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
    return { storageRef: this.refFor(key) };
  }

  async get(storageRef: string): Promise<Buffer> {
    const key = this.keyForRef(storageRef);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = out.Body;
      if (!body) throw new PacketNotFoundError(storageRef);
      // Body is a NodeJS.ReadableStream / IncomingMessage in node runtime.
      // @aws-sdk/client-s3 exposes transformToByteArray on it.
      const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (isS3NotFound(err)) throw new PacketNotFoundError(storageRef);
      throw err;
    }
  }

  private keyFor(tenantId: string, packetId: string): string {
    return `${this.keyPrefix}/${tenantId}/${packetId}.json`;
  }

  private refFor(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  private keyForRef(storageRef: string): string {
    const prefix = `s3://${this.bucket}/`;
    if (!storageRef.startsWith(prefix)) {
      throw new Error(`s3 storage get: ref bucket does not match (${storageRef})`);
    }
    return storageRef.slice(prefix.length);
  }
}

function isS3NotFound(err: unknown): boolean {
  if (err instanceof NoSuchKey) return true;
  if (err instanceof NotFound) return true;
  const name = (err as { name?: string } | null)?.name;
  // 404 metadata on HeadObject vs GetObject is normalised inconsistently by
  // @aws-sdk/client-s3 — match by name as well.
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchBucket';
}

// ── Composition helper ──────────────────────────────────────────────────

/**
 * Construct a storage backend from env. Returns undefined when no kind is
 * configured; callers should treat that as "forensic features disabled".
 *
 * Env:
 *   OWEIBO_FORENSIC_STORAGE_KIND  'filesystem' | 's3' (default 'filesystem')
 *   OWEIBO_FORENSIC_STORAGE_DIR   filesystem rootDir (default './forensic-packets')
 *   OWEIBO_FORENSIC_S3_BUCKET     S3 bucket name (required for kind=s3)
 *   OWEIBO_FORENSIC_S3_REGION     S3 region (default 'us-east-1')
 *   OWEIBO_FORENSIC_S3_PREFIX     S3 key prefix (default 'forensic')
 */
export function resolveForensicStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IForensicPacketStorage | undefined {
  const kind = env['OWEIBO_FORENSIC_STORAGE_KIND'] ?? 'filesystem';
  switch (kind) {
    case 'filesystem': {
      const rootDir = env['OWEIBO_FORENSIC_STORAGE_DIR'] ?? './forensic-packets';
      return new FilesystemForensicPacketStorage({ rootDir });
    }
    case 's3': {
      const bucket = env['OWEIBO_FORENSIC_S3_BUCKET'];
      if (!bucket) {
        throw new Error(
          'OWEIBO_FORENSIC_STORAGE_KIND=s3 requires OWEIBO_FORENSIC_S3_BUCKET',
        );
      }
      const region = env['OWEIBO_FORENSIC_S3_REGION'] ?? 'us-east-1';
      const keyPrefix = env['OWEIBO_FORENSIC_S3_PREFIX'] ?? 'forensic';
      return new S3ForensicPacketStorage({
        bucket,
        keyPrefix,
        client: new S3Client({ region }),
      });
    }
    case 'none':
    case '':
      return undefined;
    default:
      throw new Error(
        `OWEIBO_FORENSIC_STORAGE_KIND=${kind} unsupported (use filesystem | s3 | none)`,
      );
  }
}
