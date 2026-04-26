/**
 * ProfileStore — IProfileStore + S3ProfileStore + LocalProfileStore.
 * (NEW v9.5.7)
 *
 * Abstraction over object storage for Chromium user-data-dir archives.
 * Compression: tar + zstd (level 3 default).
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { IProfileStore } from '@oweibo/core-contracts';
import { BrowserPolicyViolationError } from '../contracts/errors.js';
import type { ILogger } from './SessionReaper.js';

const execFileAsync = promisify(execFile);

// ── S3ProfileStore ─────────────────────────────────────────────────────────────

// Minimal S3 client interface to avoid hard dependency on @aws-sdk/client-s3 at type level
interface IS3Client {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(cmd: any): Promise<any>;
}

// Lazy imports for AWS SDK commands — only used in S3ProfileStore
type S3CommandCtor = new (input: Record<string, unknown>) => unknown;

let GetObjectCommand: S3CommandCtor;
let PutObjectCommand: S3CommandCtor;
let DeleteObjectCommand: S3CommandCtor;
let HeadObjectCommand: S3CommandCtor;

async function lazyLoadS3Commands(): Promise<void> {
  if (GetObjectCommand) return;
  try {
    const mod = await import('@aws-sdk/client-s3');
    GetObjectCommand = mod.GetObjectCommand as unknown as S3CommandCtor;
    PutObjectCommand = mod.PutObjectCommand as unknown as S3CommandCtor;
    DeleteObjectCommand = mod.DeleteObjectCommand as unknown as S3CommandCtor;
    HeadObjectCommand = mod.HeadObjectCommand as unknown as S3CommandCtor;
  } catch {
    throw new Error('@aws-sdk/client-s3 is required for S3ProfileStore. Install it with: pnpm add @aws-sdk/client-s3');
  }
}

export class S3ProfileStore implements IProfileStore {
  constructor(
    private readonly s3: IS3Client,
    private readonly bucket: string,
    private readonly maxSizeBytes: number, // default 200 MB
    private readonly logger: ILogger,
  ) {}

  async restore(profileKey: string, targetDir: string): Promise<boolean> {
    await lazyLoadS3Commands();
    const key = this.s3Key(profileKey);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Body } = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })) as any;
      if (!Body) return false;
      await fs.mkdir(targetDir, { recursive: true });
      await this.extractStream(Body, targetDir);
      this.logger.info({ profileKey, targetDir }, 'Profile restored from S3.');
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'NoSuchKey') return false;
      throw err;
    }
  }

  async snapshot(profileKey: string, sourceDir: string): Promise<{ sizeBytes: number }> {
    await lazyLoadS3Commands();
    const archive = await this.compress(sourceDir);
    if (archive.byteLength > this.maxSizeBytes) {
      throw new BrowserPolicyViolationError(
        `Profile snapshot aborted: ${archive.byteLength} bytes exceeds limit of ${this.maxSizeBytes}.`,
      );
    }
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.s3Key(profileKey),
      Body: archive,
      ContentType: 'application/zstd',
      ContentLength: archive.byteLength,
    }));
    this.logger.info({ profileKey, sizeBytes: archive.byteLength }, 'Profile snapshotted to S3.');
    return { sizeBytes: archive.byteLength };
  }

  async delete(profileKey: string): Promise<void> {
    await lazyLoadS3Commands();
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.s3Key(profileKey),
    }));
  }

  async exists(profileKey: string): Promise<boolean> {
    await lazyLoadS3Commands();
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.s3Key(profileKey),
      }));
      return true;
    } catch {
      return false;
    }
  }

  private s3Key(profileKey: string): string {
    return `profiles/${profileKey.replace(/[:/\\]/g, '-')}.tar.zst`;
  }

  private async compress(sourceDir: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        'sh',
        ['-c', `tar -C "${sourceDir}" -cf - . | zstd -3 -`],
        { maxBuffer: 300 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout) => (err ? reject(err) : resolve(stdout as unknown as Buffer)),
      );
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async extractStream(stream: any, targetDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', `zstd -d | tar -xf - -C "${targetDir}"`]);
      stream.pipe(child.stdin);
      child.on('close', (code: number) =>
        code === 0 ? resolve() : reject(new Error(`extract exited ${code}`)),
      );
    });
  }
}

// ── LocalProfileStore ──────────────────────────────────────────────────────────

export class LocalProfileStore implements IProfileStore {
  constructor(private readonly baseDir: string) {}

  private archivePath(profileKey: string): string {
    return path.join(this.baseDir, profileKey.replace(/[:/\\]/g, '-') + '.tar.zst');
  }

  async restore(profileKey: string, targetDir: string): Promise<boolean> {
    const archive = this.archivePath(profileKey);
    try {
      await fs.access(archive);
    } catch {
      return false;
    }
    await fs.mkdir(targetDir, { recursive: true });
    await execFileAsync('sh', ['-c', `zstd -d < "${archive}" | tar -xf - -C "${targetDir}"`]);
    return true;
  }

  async snapshot(profileKey: string, sourceDir: string): Promise<{ sizeBytes: number }> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const archive = this.archivePath(profileKey);
    await execFileAsync('sh', ['-c', `tar -C "${sourceDir}" -cf - . | zstd -3 > "${archive}"`]);
    const { size } = await fs.stat(archive);
    return { sizeBytes: size };
  }

  async delete(profileKey: string): Promise<void> {
    await fs.rm(this.archivePath(profileKey), { force: true });
  }

  async exists(profileKey: string): Promise<boolean> {
    try {
      await fs.access(this.archivePath(profileKey));
      return true;
    } catch {
      return false;
    }
  }
}
