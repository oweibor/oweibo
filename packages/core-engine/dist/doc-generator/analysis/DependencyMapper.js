"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependencyMapper = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * DependencyMapper — lockfile-first dependency resolution with license extraction.
 *
 * Resolution order (per plan §4.1.9):
 *   1. pnpm-lock.yaml
 *   2. package-lock.json
 *   3. yarn.lock
 *   4. package.json ranges (flagged versionSource: 'manifest')
 *
 * License extraction:
 *   1. Lockfile metadata (pnpm-lock.yaml v9+ has per-package licenses)
 *   2. node_modules/<pkg>/package.json
 *   3. unresolved + LICENSE_UNRESOLVED warning
 */
class DependencyMapper {
    logger;
    options;
    constructor(logger, options = {}) {
        this.logger = logger;
        this.options = options;
    }
    async map(rootPath, signal) {
        signal?.throwIfAborted();
        // Try lockfiles in order
        let deps = await this.tryPnpmLock(rootPath);
        if (!deps)
            deps = await this.tryNpmLock(rootPath);
        if (!deps)
            deps = await this.tryYarnLock(rootPath);
        if (!deps)
            deps = await this.readManifest(rootPath);
        return deps ?? [];
    }
    async tryPnpmLock(rootPath) {
        const lockPath = node_path_1.default.join(rootPath, 'pnpm-lock.yaml');
        try {
            const raw = await promises_1.default.readFile(lockPath, 'utf-8');
            const results = [];
            // Naive YAML parse — extract package keys + versions without a full YAML parser
            const pkgBlockRe = /^  ([\w@][^:\n]+):\s*\n(?:    [^\n]+\n)*/gm;
            for (const [, pkg] of raw.matchAll(pkgBlockRe)) {
                if (!pkg)
                    continue;
                const name = pkg.trim().replace(/@[^@]+$/, '');
                const verMatch = raw.match(new RegExp(`${escapeRx(pkg)}.*?version: ([\\S]+)`, 's'));
                const licMatch = raw.match(new RegExp(`${escapeRx(pkg)}.*?license: ([\\S]+)`, 's'));
                results.push({
                    name,
                    version: verMatch?.[1],
                    versionSource: 'lockfile-pnpm',
                    license: licMatch?.[1],
                    licenseSource: licMatch?.[1] ? 'lockfile' : 'unresolved',
                    isDev: false,
                    purpose: '',
                });
            }
            if (results.length > 0)
                return results;
        }
        catch { /* no pnpm lock */ }
        return null;
    }
    async tryNpmLock(rootPath) {
        const lockPath = node_path_1.default.join(rootPath, 'package-lock.json');
        try {
            const raw = await promises_1.default.readFile(lockPath, 'utf-8');
            const lock = JSON.parse(raw);
            const pkgs = lock.packages ?? lock.dependencies ?? {};
            const results = [];
            for (const [key, meta] of Object.entries(pkgs)) {
                const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key;
                if (!name)
                    continue;
                const license = await this.readNodeModulesLicense(rootPath, name);
                results.push({
                    name,
                    version: meta.version,
                    versionSource: 'lockfile-npm',
                    license: license?.value,
                    licenseSource: license?.source ?? 'unresolved',
                    isDev: meta.dev ?? false,
                    purpose: '',
                });
            }
            if (results.length > 0)
                return results;
        }
        catch { /* no npm lock */ }
        return null;
    }
    async tryYarnLock(rootPath) {
        const lockPath = node_path_1.default.join(rootPath, 'yarn.lock');
        try {
            const raw = await promises_1.default.readFile(lockPath, 'utf-8');
            const results = [];
            const blockRe = /^"?([\w@][^"@\n]+)@[^":\n]+"?:\s*\n  version "([^"]+)"/gm;
            for (const [, name, version] of raw.matchAll(blockRe)) {
                if (!name)
                    continue;
                results.push({
                    name: name.trim(),
                    version,
                    versionSource: 'lockfile-yarn',
                    license: undefined,
                    licenseSource: 'unresolved',
                    isDev: false,
                    purpose: '',
                });
            }
            if (results.length > 0)
                return results;
        }
        catch { /* no yarn lock */ }
        return null;
    }
    async readManifest(rootPath) {
        const manifestPath = node_path_1.default.join(rootPath, 'package.json');
        try {
            const raw = await promises_1.default.readFile(manifestPath, 'utf-8');
            const pkg = JSON.parse(raw);
            const results = [];
            for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
                results.push({ name, version, versionSource: 'manifest', license: undefined, licenseSource: 'unresolved', isDev: false, purpose: '' });
            }
            for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
                results.push({ name, version, versionSource: 'manifest', license: undefined, licenseSource: 'unresolved', isDev: true, purpose: '' });
            }
            return results;
        }
        catch {
            return [];
        }
    }
    async readNodeModulesLicense(rootPath, name) {
        const pkgJsonPath = node_path_1.default.join(rootPath, 'node_modules', name, 'package.json');
        try {
            const raw = await promises_1.default.readFile(pkgJsonPath, 'utf-8');
            const pkg = JSON.parse(raw);
            const lic = typeof pkg.license === 'string'
                ? pkg.license
                : pkg.license?.type;
            if (lic)
                return { value: lic, source: 'node_modules' };
        }
        catch { /* package not installed */ }
        this.logger.debug({ name }, 'LICENSE_UNRESOLVED');
        return null;
    }
}
exports.DependencyMapper = DependencyMapper;
function escapeRx(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=DependencyMapper.js.map