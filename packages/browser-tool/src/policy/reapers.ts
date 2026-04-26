// packages/browser-tool/src/policy/reapers.ts
// Periodic janitors (§7.4) — delete videos / HARs / PDFs older than the retention
// window. Wired into the SessionReaper schedule.
import * as fs from 'fs/promises';
import * as path from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

async function reapDir(dir: string, maxAgeMs: number): Promise<number> {
  let removed = 0;
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await fs.stat(full);
      if (Date.now() - st.mtimeMs > maxAgeMs) { await fs.unlink(full); removed++; }
    } catch { /* ignore */ }
  }
  return removed;
}

export class VideoReaper {
  constructor(private readonly dir: string, private readonly retentionDays = 7) {}
  reap(): Promise<number> { return reapDir(this.dir, this.retentionDays * DAY_MS); }
}
export class HarReaper {
  constructor(private readonly dir: string, private readonly retentionDays = 7) {}
  reap(): Promise<number> { return reapDir(this.dir, this.retentionDays * DAY_MS); }
}
export class PdfReaper {
  constructor(private readonly dir: string, private readonly retentionDays = 14) {}
  reap(): Promise<number> { return reapDir(this.dir, this.retentionDays * DAY_MS); }
}

export class ClamAvFreshnessJob {
  constructor(private readonly clamAvSocketPath: string) {}
  async run(): Promise<{ ok: boolean; freshness: string }> {
    // Stub: ping ClamAV daemon and check signature db timestamp.
    return { ok: true, freshness: new Date().toISOString() };
  }
}
