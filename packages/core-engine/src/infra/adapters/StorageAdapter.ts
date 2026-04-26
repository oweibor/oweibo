// packages/core-engine/src/infra/adapters/StorageAdapter.ts
import * as fs from 'fs';
import * as path from 'path';

export interface StorageAdapter {
  put(key: string, data: Buffer, meta?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly basePath: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const fullPath = path.join(this.basePath, key);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(path.join(this.basePath, key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.promises.unlink(path.join(this.basePath, key)).catch(() => {});
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const dir = await fs.promises.readdir(this.basePath);
      return dir.filter(f => f.startsWith(prefix));
    } catch {
      return [];
    }
  }
}

// S3StorageAdapter — production cloud storage backend
export class S3StorageAdapter implements StorageAdapter {
  constructor(
    private readonly client: { send(cmd: unknown): Promise<unknown> },
    private readonly bucket: string,
    private readonly commandFactory: {
      put(bucket: string, key: string, body: Buffer, meta?: Record<string, string>): unknown;
      get(bucket: string, key: string): unknown;
      delete(bucket: string, key: string): unknown;
      list(bucket: string, prefix: string): unknown;
    },
  ) {}

  async put(key: string, data: Buffer, meta?: Record<string, string>): Promise<void> {
    await this.client.send(this.commandFactory.put(this.bucket, key, data, meta));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(this.commandFactory.get(this.bucket, key)) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(this.commandFactory.delete(this.bucket, key));
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.send(this.commandFactory.list(this.bucket, prefix)) as {
      Contents?: Array<{ Key?: string }>;
    };
    return (res.Contents ?? []).map(o => o.Key!).filter(Boolean);
  }
}
