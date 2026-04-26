import fs from 'node:fs/promises';
import path from 'node:path';
import type { ILogger } from './validateGlobPatterns.js';

export type VersionSource = 'lockfile-pnpm' | 'lockfile-npm' | 'lockfile-yarn' | 'manifest' | 'unresolved';
export type LicenseSource = 'lockfile' | 'node_modules' | 'unresolved';

export interface ResolvedDependency {
  readonly name:           string;
  readonly version:        string | undefined;
  readonly versionSource:  VersionSource;
  readonly license:        string | undefined;
  readonly licenseSource:  LicenseSource;
  readonly isDev:          boolean;
  /** LLM-generated one-line description (empty when skipLLM=true). */
  readonly purpose:        string;
}

export interface DependencyMapperOptions {
  readonly skipLLM?: boolean;
}

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
export class DependencyMapper {
  constructor(
    private readonly logger:  ILogger,
    private readonly options: DependencyMapperOptions = {},
  ) {}

  async map(
    rootPath: string,
    signal?:  AbortSignal,
  ): Promise<readonly ResolvedDependency[]> {
    signal?.throwIfAborted();

    // Try lockfiles in order
    let deps = await this.tryPnpmLock(rootPath);
    if (!deps) deps = await this.tryNpmLock(rootPath);
    if (!deps) deps = await this.tryYarnLock(rootPath);
    if (!deps) deps = await this.readManifest(rootPath);

    return deps ?? [];
  }

  private async tryPnpmLock(rootPath: string): Promise<ResolvedDependency[] | null> {
    const lockPath = path.join(rootPath, 'pnpm-lock.yaml');
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      const results: ResolvedDependency[] = [];
      // Naive YAML parse — extract package keys + versions without a full YAML parser
      const pkgBlockRe = /^  ([\w@][^:\n]+):\s*\n(?:    [^\n]+\n)*/gm;
      for (const [, pkg] of raw.matchAll(pkgBlockRe)) {
        if (!pkg) continue;
        const name    = pkg.trim().replace(/@[^@]+$/, '');
        const verMatch = raw.match(new RegExp(`${escapeRx(pkg)}.*?version: ([\\S]+)`, 's'));
        const licMatch = raw.match(new RegExp(`${escapeRx(pkg)}.*?license: ([\\S]+)`, 's'));
        results.push({
          name,
          version:       verMatch?.[1],
          versionSource: 'lockfile-pnpm',
          license:       licMatch?.[1],
          licenseSource: licMatch?.[1] ? 'lockfile' : 'unresolved',
          isDev:         false,
          purpose:       '',
        });
      }
      if (results.length > 0) return results;
    } catch { /* no pnpm lock */ }
    return null;
  }

  private async tryNpmLock(rootPath: string): Promise<ResolvedDependency[] | null> {
    const lockPath = path.join(rootPath, 'package-lock.json');
    try {
      const raw  = await fs.readFile(lockPath, 'utf-8');
      const lock = JSON.parse(raw) as {
        packages?: Record<string, { version?: string; dev?: boolean }>;
        dependencies?: Record<string, { version?: string; dev?: boolean }>;
      };
      const pkgs = lock.packages ?? lock.dependencies ?? {};
      const results: ResolvedDependency[] = [];
      for (const [key, meta] of Object.entries(pkgs)) {
        const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key;
        if (!name) continue;
        const license = await this.readNodeModulesLicense(rootPath, name);
        results.push({
          name,
          version:       meta.version,
          versionSource: 'lockfile-npm',
          license:       license?.value,
          licenseSource: license?.source ?? 'unresolved',
          isDev:         meta.dev ?? false,
          purpose:       '',
        });
      }
      if (results.length > 0) return results;
    } catch { /* no npm lock */ }
    return null;
  }

  private async tryYarnLock(rootPath: string): Promise<ResolvedDependency[] | null> {
    const lockPath = path.join(rootPath, 'yarn.lock');
    try {
      const raw     = await fs.readFile(lockPath, 'utf-8');
      const results: ResolvedDependency[] = [];
      const blockRe = /^"?([\w@][^"@\n]+)@[^":\n]+"?:\s*\n  version "([^"]+)"/gm;
      for (const [, name, version] of raw.matchAll(blockRe)) {
        if (!name) continue;
        results.push({
          name:          name.trim(),
          version,
          versionSource: 'lockfile-yarn',
          license:       undefined,
          licenseSource: 'unresolved',
          isDev:         false,
          purpose:       '',
        });
      }
      if (results.length > 0) return results;
    } catch { /* no yarn lock */ }
    return null;
  }

  private async readManifest(rootPath: string): Promise<ResolvedDependency[]> {
    const manifestPath = path.join(rootPath, 'package.json');
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const results: ResolvedDependency[] = [];
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        results.push({ name, version, versionSource: 'manifest', license: undefined, licenseSource: 'unresolved', isDev: false, purpose: '' });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        results.push({ name, version, versionSource: 'manifest', license: undefined, licenseSource: 'unresolved', isDev: true, purpose: '' });
      }
      return results;
    } catch {
      return [];
    }
  }

  private async readNodeModulesLicense(
    rootPath: string,
    name: string,
  ): Promise<{ value: string; source: LicenseSource } | null> {
    const pkgJsonPath = path.join(rootPath, 'node_modules', name, 'package.json');
    try {
      const raw = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkg = JSON.parse(raw) as { license?: string | { type?: string } };
      const lic = typeof pkg.license === 'string'
        ? pkg.license
        : pkg.license?.type;
      if (lic) return { value: lic, source: 'node_modules' };
    } catch { /* package not installed */ }
    this.logger.debug({ name }, 'LICENSE_UNRESOLVED');
    return null;
  }
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
