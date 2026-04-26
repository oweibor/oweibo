"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteSkillFetcher = void 0;
// packages/core-engine/src/general-coding/project/RemoteSkillFetcher.ts
// Materialises remote skill sources to disk (§22.15)
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
const simple_git_1 = __importDefault(require("simple-git"));
/**
 * RemoteSkillFetcher — materialises remote skill sources to .oweibo/skills/ so
 * SkillRegistry.discover() finds them with no knowledge of remote origins.
 *
 * Auth tokens for private sources are read from Vault and discarded after use.
 * simpleGit is already a dep via GitAdapter — no new deps added.
 */
class RemoteSkillFetcher {
    vault;
    static MANIFEST_FILE = '.oweibo/skills-sources.json';
    static LOCKFILE = '.oweibo/skills.lock';
    static REMOTE_PREFIX = 'remote-';
    constructor(vault) {
        this.vault = vault;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    hasManifest(repoRoot) {
        const p = path.join(repoRoot, RemoteSkillFetcher.MANIFEST_FILE);
        if (!fs.existsSync(p))
            return false;
        try {
            const m = JSON.parse(fs.readFileSync(p, 'utf8'));
            return Array.isArray(m.sources) && m.sources.length > 0;
        }
        catch {
            return false;
        }
    }
    async fetchAll(repoRoot, tenantId) {
        const manifest = this.readManifest(repoRoot);
        if (!manifest)
            return 0;
        let count = 0;
        for (const source of manifest.sources) {
            count += await this.fetchSource(source, repoRoot, tenantId);
        }
        return count;
    }
    async fetchOne(sourceId, repoRoot, tenantId) {
        const manifest = this.readManifest(repoRoot);
        const source = manifest?.sources.find(s => s.id === sourceId);
        if (!source)
            throw new Error(`No remote skill source '${sourceId}' in manifest`);
        return this.fetchSource(source, repoRoot, tenantId);
    }
    verifyIntegrity(repoRoot) {
        const report = { ok: [], tampered: [], unknown: [] };
        const lockfile = this.readLockfile(repoRoot);
        if (!lockfile)
            return report;
        const skillsDir = path.join(repoRoot, '.oweibo', 'skills');
        if (!fs.existsSync(skillsDir))
            return report;
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith(RemoteSkillFetcher.REMOTE_PREFIX))
                continue;
            const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
            const sidecar = path.join(skillsDir, entry.name, '.skill-source.json');
            if (!fs.existsSync(skillFile) || !fs.existsSync(sidecar))
                continue;
            let meta;
            try {
                meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
            }
            catch {
                report.tampered.push(skillFile);
                continue;
            }
            const lockedEntry = lockfile.sources[meta.sourceId];
            const skillId = entry.name.slice(RemoteSkillFetcher.REMOTE_PREFIX.length + meta.sourceId.length + 1);
            const lockedHash = lockedEntry?.skills[skillId];
            if (!lockedHash) {
                report.unknown.push(skillFile);
                continue;
            }
            const actualHash = crypto.createHash('sha256').update(fs.readFileSync(skillFile)).digest('hex');
            (actualHash === lockedHash ? report.ok : report.tampered).push(skillFile);
        }
        return report;
    }
    removeSource(sourceId, repoRoot) {
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
    async fetchSource(source, repoRoot, _tenantId) {
        const token = source.vaultTokenPath
            ? await this.vault.read(source.vaultTokenPath)
                .then(d => d?.['token'])
                .catch(() => undefined)
            : undefined;
        switch (source.type) {
            case 'git': return this.fetchGit(source, repoRoot, token);
            case 'https': return this.fetchHttps(source, repoRoot, token);
            default: throw new Error(`Unknown remote skill source type: ${source.type}`);
        }
    }
    async fetchGit(source, repoRoot, token) {
        const ref = source.subdir ?? 'main';
        const remotePath = '.';
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oweibo-skills-'));
        let count = 0;
        try {
            const cloneUrl = token ? source.url.replace('https://', `https://${token}@`) : source.url;
            const git = (0, simple_git_1.default)();
            await git.clone(cloneUrl, tmpDir, ['--depth', '1', '--filter=blob:none', '--no-checkout']);
            const repoGit = (0, simple_git_1.default)(tmpDir);
            await repoGit.raw(['sparse-checkout', 'init', '--cone']);
            await repoGit.raw(['sparse-checkout', 'set', remotePath]);
            await repoGit.checkout(ref);
            const pinnedCommit = (await repoGit.revparse(['HEAD'])).trim();
            const scanRoot = path.join(tmpDir, remotePath);
            if (!fs.existsSync(scanRoot))
                return 0;
            const lockfile = this.readLockfile(repoRoot) ?? this.emptyLockfile();
            const lockEntry = this.ensureLockEntry(lockfile, source, pinnedCommit);
            for (const entry of fs.readdirSync(scanRoot, { withFileTypes: true })) {
                if (!entry.isDirectory())
                    continue;
                const candidateSkillFile = path.join(scanRoot, entry.name, 'SKILL.md');
                if (!fs.existsSync(candidateSkillFile))
                    continue;
                const skillContent = fs.readFileSync(candidateSkillFile, 'utf8');
                this.materialiseSkill(source, entry.name, skillContent, pinnedCommit, repoRoot, lockEntry);
                count++;
            }
            this.writeLockfile(repoRoot, lockfile);
            console.log(`[RemoteSkillFetcher] Fetched ${count} skill(s) from git '${source.id}' @ ${pinnedCommit.slice(0, 8)}`);
        }
        finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        return count;
    }
    async fetchHttps(source, repoRoot, token) {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        let count = 0;
        const lockfile = this.readLockfile(repoRoot) ?? this.emptyLockfile();
        if (source.url.endsWith('SKILL.md')) {
            const body = await this.httpGet(source.url, headers);
            const skillName = path.basename(path.dirname(source.url));
            const pin = this.sha256(body);
            const lockEntry = this.ensureLockEntry(lockfile, source, pin);
            this.materialiseSkill(source, skillName, body, pin, repoRoot, lockEntry);
            count = 1;
        }
        else {
            const indexBody = await this.httpGet(source.url, headers);
            let index;
            try {
                index = JSON.parse(indexBody);
            }
            catch {
                throw new Error(`Remote skill source '${source.id}': expected JSON index at ${source.url}`);
            }
            const pin = this.sha256(indexBody);
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
    async httpGet(url, headers) {
        const res = await fetch(url, { headers });
        if (!res.ok)
            throw new Error(`HTTP ${res.status} fetching ${url}`);
        return res.text();
    }
    materialiseSkill(source, skillName, content, pinnedCommit, repoRoot, lockEntry) {
        const dirName = `${RemoteSkillFetcher.REMOTE_PREFIX}${source.id}-${this.toDashedId(skillName)}`;
        const skillDir = path.join(repoRoot, '.oweibo', 'skills', dirName);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
        const sidecar = {
            sourceId: source.id,
            pinnedCommit: pinnedCommit,
            fetchedAt: new Date().toISOString(),
            remoteUrl: source.url,
        };
        fs.writeFileSync(path.join(skillDir, '.skill-source.json'), JSON.stringify(sidecar, null, 2), 'utf8');
        const skillId = this.toDashedId(skillName);
        lockEntry.skills[skillId] = this.sha256(content);
    }
    readManifest(repoRoot) {
        const p = path.join(repoRoot, RemoteSkillFetcher.MANIFEST_FILE);
        if (!fs.existsSync(p))
            return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
        catch {
            return null;
        }
    }
    writeManifest(repoRoot, manifest) {
        fs.writeFileSync(path.join(repoRoot, RemoteSkillFetcher.MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
    }
    readLockfile(repoRoot) {
        const p = path.join(repoRoot, RemoteSkillFetcher.LOCKFILE);
        if (!fs.existsSync(p))
            return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
        catch {
            return null;
        }
    }
    writeLockfile(repoRoot, lockfile) {
        lockfile.generatedAt = new Date().toISOString();
        fs.mkdirSync(path.join(repoRoot, '.oweibo'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, RemoteSkillFetcher.LOCKFILE), JSON.stringify(lockfile, null, 2), 'utf8');
    }
    emptyLockfile() {
        return { version: 1, generatedAt: new Date().toISOString(), sources: {} };
    }
    ensureLockEntry(lockfile, source, pinnedCommit) {
        if (!lockfile.sources[source.id]) {
            lockfile.sources[source.id] = {
                type: source.type, url: source.url, pinnedCommit, fetchedAt: new Date().toISOString(), skills: {},
            };
        }
        else {
            Object.assign(lockfile.sources[source.id], { pinnedCommit, fetchedAt: new Date().toISOString(), skills: {} });
        }
        return lockfile.sources[source.id];
    }
    toDashedId(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    sha256(content) {
        return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }
}
exports.RemoteSkillFetcher = RemoteSkillFetcher;
//# sourceMappingURL=RemoteSkillFetcher.js.map