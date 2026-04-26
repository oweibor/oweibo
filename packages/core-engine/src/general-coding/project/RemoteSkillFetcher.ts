// packages/core-engine/src/general-coding/project/RemoteSkillFetcher.ts
// Materialises remote skill sources to disk (§22.15)
import * as fs         from 'fs';
import * as path       from 'path';
import * as crypto     from 'crypto';
import * as os         from 'os';
import simpleGit       from 'simple-git';
import type { IRemoteSkillSource } from '@oweibo/core-contracts';
import type { VaultClient }        from '../../infrastructure/VaultClient.js';

interface SkillsManifest  { version: 1; sources: IRemoteSkillSource[]; }
interface SkillsLockfile  { version: 1; generatedAt: string; sources: Record<string, SourceLockEntry>; }
interface SourceLockEntry { type: string; url: string; pinnedCommit: string; fetchedAt: string; skills: Record<string, string>; }
interface SkillSourceSidecar { sourceId: string; pinnedCommit: string; fetchedAt: string; remoteUrl: string; }

export interface IntegrityReport {
  ok:       string[];
  tampered: string[];
  unknown:  string[];
}

/**
 * RemoteSkillFetcher — materialises remote skill sources to .oweibo/skills/ so
 * SkillRegistry.discover() finds them with no knowledge of remote origins.
 *
 * Auth tokens for private sources are read from Vault and discarded after use.
 * simpleGit is already a dep via GitAdapter — no new deps added.
 */
export class RemoteSkillFetcher {
  private static readonly MANIFEST_FILE = '.oweibo/skills-sources.json';
  private static readonly LOCKFILE      = '.oweibo/skills.lock';
  private static readonly REMOTE_PREFIX = 'remote-';

  constructor(
    private readonly vault: VaultClient,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  hasManifest(repoRoot: string): boolean {
    const p = path.join(repoRoot, RemoteSkillFetcher.MANIFEST_FILE);
    if (!fs.existsSync(p)) return false;
    try {
      const m = JSON.parse(fs.readFileSync(p, 'utf8')) as SkillsManifest;
      return Array.isArray(m.sources) && m.sources.length > 0;
    } catch { return false; }
  }

  async fetchAll(repoRoot: string, tenantId: string): Promise<number> {
    const manifest = this.readManifest(repoRoot);
    if (!manifest) return 0;
    let count = 0;
    for (const source of manifest.sources) {
      count += await this.fetchSource(source, repoRoot, tenantId);
    }
    return count;
  }

  async fetchOne(sourceId: string, repoRoot: string, tenantId: string): Promise<number> {
    const manifest = this.readManifest(repoRoot);
    const source   = manifest?.sources.find(s => s.id === sourceId);
    if (!source) throw new Error(`No remote skill source '${sourceId}' in manifest`);
    return this.fetchSource(source, repoRoot, tenantId);
  }

  verifyIntegrity(repoRoot: string): IntegrityReport {
    const report: IntegrityReport = { ok: [], tampered: [], unknown: [] };
    const lockfile = this.readLockfile(repoRoot);
    if (!lockfile) return report;

    const skillsDir = path.join(repoRoot, '.oweibo', 'skills');
    if (!fs.existsSync(skillsDir)) return report;

    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(RemoteSkillFetcher.REMOTE_PREFIX)) continue;

      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      const sidecar   = path.join(skillsDir, entry.name, '.skill-source.json');
      if (!fs.existsSync(skillFile) || !fs.existsSync(sidecar)) continue;

      let meta: SkillSourceSidecar;
      try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as SkillSourceSidecar; }
      catch { report.tampered.push(skillFile); continue; }

      const lockedEntry = lockfile.sources[meta.sourceId];
      const skillId     = entry.name.slice(RemoteSkillFetcher.REMOTE_PREFIX.length + meta.sourceId.length + 1);
      const lockedHash  = lockedEntry?.skills[skillId];

      if (!lockedHash) { report.unknown.push(skillFile); continue; }

      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(skillFile)).digest('hex');
      (actualHash === lockedHash ? report.ok : report.tampered).push(skillFile);
    }

    return report;
  }

  removeSource(sourceId: string, repoRoot: string): void {
    const skillsDir = path.join(repoRoot, '.oweibo', 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(`${RemoteSkillFetcher.REMOTE_PREFIX}${sourceId}-`)) {
          fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        }
      }
    }

    const manifest = this.readManifest(repoRoot);
    if (manifest) {
      this.writeManifest(repoRoot, { ...manifest, sources: manifest.sources.filter(s => s.id !== sourceId) });
    }

    const lockfile = this.readLockfile(repoRoot);
    if (lockfile) {
      delete lockfile.sources[sourceId];
      this.writeLockfile(repoRoot, lockfile);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchSource(source: IRemoteSkillSource, repoRoot: string, _tenantId: string): Promise<number> {
    const token = source.vaultTokenPath
      ? await this.vault.read(source.vaultTokenPath)
          .then(d => d?.['token'] as string | undefined)
          .catch(() => undefined)
      : undefined;

    switch (source.type) {
      case 'git':   return this.fetchGit(source, repoRoot, token);
      case 'https': return this.fetchHttps(source, repoRoot, token);
      default:      throw new Error(`Unknown remote skill source type: ${(source as { type: string }).type}`);
    }
  }

  private async fetchGit(source: IRemoteSkillSource, repoRoot: string, token?: string): Promise<number> {
    const ref        = source.subdir ?? 'main';
    const remotePath = '.';
    const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'oweibo-skills-'));
    let count        = 0;

    try {
      const cloneUrl = token ? source.url.replace('https://', `https://${token}@`) : source.url;
      const git = simpleGit();
      await git.clone(cloneUrl, tmpDir, ['--depth', '1', '--filter=blob:none', '--no-checkout']);

      const repoGit = simpleGit(tmpDir);
      await repoGit.raw(['sparse-checkout', 'init', '--cone']);
      await repoGit.raw(['sparse-checkout', 'set', remotePath]);
      await repoGit.checkout(ref);

      const pinnedCommit = (await repoGit.revparse(['HEAD'])).trim();
      const scanRoot     = path.join(tmpDir, remotePath);
      if (!fs.existsSync(scanRoot)) return 0;

      const lockfile  = this.readLockfile(repoRoot) ?? this.emptyLockfile();
      const lockEntry = this.ensureLockEntry(lockfile, source, pinnedCommit);

      for (const entry of fs.readdirSync(scanRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidateSkillFile = path.join(scanRoot, entry.name, 'SKILL.md');
        if (!fs.existsSync(candidateSkillFile)) continue;
        const skillContent = fs.readFileSync(candidateSkillFile, 'utf8');
        this.materialiseSkill(source, entry.name, skillContent, pinnedCommit, repoRoot, lockEntry);
        count++;
      }

      this.writeLockfile(repoRoot, lockfile);
      console.log(`[RemoteSkillFetcher] Fetched ${count} skill(s) from git '${source.id}' @ ${pinnedCommit.slice(0, 8)}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return count;
  }

  private async fetchHttps(source: IRemoteSkillSource, repoRoot: string, token?: string): Promise<number> {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    let count = 0;
    const lockfile = this.readLockfile(repoRoot) ?? this.emptyLockfile();

    if (source.url.endsWith('SKILL.md')) {
      const body      = await this.httpGet(source.url, headers);
      const skillName = path.basename(path.dirname(source.url));
      const pin       = this.sha256(body);
      const lockEntry = this.ensureLockEntry(lockfile, source, pin);
      this.materialiseSkill(source, skillName, body, pin, repoRoot, lockEntry);
      count = 1;
    } else {
      const indexBody = await this.httpGet(source.url, headers);
      let index: Array<{ name: string; url: string }>;
      try { index = JSON.parse(indexBody) as Array<{ name: string; url: string }>; }
      catch { throw new Error(`Remote skill source '${source.id}': expected JSON index at ${source.url}`); }

      const pin       = this.sha256(indexBody);
      const lockEntry = this.ensureLockEntry(lockfile, source, pin);

      for (const item of index) {
        const content = await this.httpGet(item.url, headers);
        this.materialiseSkill(source, item.name, content, this.sha256(content), repoRoot, lockEntry);
        count++;
      }
    }

    this.writeLockfile(repoRoot, lockfile);
    return count;
  }

  private async httpGet(url: string, headers: Record<string, string>): Promise<string> {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }

  private materialiseSkill(
    source:       IRemoteSkillSource,
    skillName:    string,
    content:      string,
    pinnedCommit: string,
    repoRoot:     string,
    lockEntry:    SourceLockEntry,
  ): void {
    const dirName  = `${RemoteSkillFetcher.REMOTE_PREFIX}${source.id}-${this.toDashedId(skillName)}`;
    const skillDir = path.join(repoRoot, '.oweibo', 'skills', dirName);
    fs.mkdirSync(skillDir, { recursive: true });

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
    const sidecar: SkillSourceSidecar = {
      sourceId:     source.id,
      pinnedCommit: pinnedCommit,
      fetchedAt:    new Date().toISOString(),
      remoteUrl:    source.url,
    };
    fs.writeFileSync(path.join(skillDir, '.skill-source.json'), JSON.stringify(sidecar, null, 2), 'utf8');

    const skillId = this.toDashedId(skillName);
    lockEntry.skills[skillId] = this.sha256(content);
  }

  private readManifest(repoRoot: string): SkillsManifest | null {
    const p = path.join(repoRoot, RemoteSkillFetcher.MANIFEST_FILE);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) as SkillsManifest; }
    catch { return null; }
  }

  private writeManifest(repoRoot: string, manifest: SkillsManifest): void {
    fs.writeFileSync(
      path.join(repoRoot, RemoteSkillFetcher.MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
  }

  private readLockfile(repoRoot: string): SkillsLockfile | null {
    const p = path.join(repoRoot, RemoteSkillFetcher.LOCKFILE);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) as SkillsLockfile; }
    catch { return null; }
  }

  private writeLockfile(repoRoot: string, lockfile: SkillsLockfile): void {
    lockfile.generatedAt = new Date().toISOString();
    fs.mkdirSync(path.join(repoRoot, '.oweibo'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, RemoteSkillFetcher.LOCKFILE),
      JSON.stringify(lockfile, null, 2),
      'utf8',
    );
  }

  private emptyLockfile(): SkillsLockfile {
    return { version: 1, generatedAt: new Date().toISOString(), sources: {} };
  }

  private ensureLockEntry(lockfile: SkillsLockfile, source: IRemoteSkillSource, pinnedCommit: string): SourceLockEntry {
    if (!lockfile.sources[source.id]) {
      lockfile.sources[source.id] = {
        type: source.type, url: source.url, pinnedCommit, fetchedAt: new Date().toISOString(), skills: {},
      };
    } else {
      Object.assign(lockfile.sources[source.id]!, { pinnedCommit, fetchedAt: new Date().toISOString(), skills: {} });
    }
    return lockfile.sources[source.id]!;
  }

  private toDashedId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  private sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }
}
