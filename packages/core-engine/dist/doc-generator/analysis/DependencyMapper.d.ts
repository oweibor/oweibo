import type { ILogger } from './validateGlobPatterns.js';
export type VersionSource = 'lockfile-pnpm' | 'lockfile-npm' | 'lockfile-yarn' | 'manifest' | 'unresolved';
export type LicenseSource = 'lockfile' | 'node_modules' | 'unresolved';
export interface ResolvedDependency {
    readonly name: string;
    readonly version: string | undefined;
    readonly versionSource: VersionSource;
    readonly license: string | undefined;
    readonly licenseSource: LicenseSource;
    readonly isDev: boolean;
    /** LLM-generated one-line description (empty when skipLLM=true). */
    readonly purpose: string;
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
export declare class DependencyMapper {
    private readonly logger;
    private readonly options;
    constructor(logger: ILogger, options?: DependencyMapperOptions);
    map(rootPath: string, signal?: AbortSignal): Promise<readonly ResolvedDependency[]>;
    private tryPnpmLock;
    private tryNpmLock;
    private tryYarnLock;
    private readManifest;
    private readNodeModulesLicense;
}
//# sourceMappingURL=DependencyMapper.d.ts.map