import type { VaultClient } from '../../infrastructure/VaultClient.js';
export interface IntegrityReport {
    ok: string[];
    tampered: string[];
    unknown: string[];
}
/**
 * RemoteSkillFetcher — materialises remote skill sources to .oweibo/skills/ so
 * SkillRegistry.discover() finds them with no knowledge of remote origins.
 *
 * Auth tokens for private sources are read from Vault and discarded after use.
 * simpleGit is already a dep via GitAdapter — no new deps added.
 */
export declare class RemoteSkillFetcher {
    private readonly vault;
    private static readonly MANIFEST_FILE;
    private static readonly LOCKFILE;
    private static readonly REMOTE_PREFIX;
    constructor(vault: VaultClient);
    hasManifest(repoRoot: string): boolean;
    fetchAll(repoRoot: string, tenantId: string): Promise<number>;
    fetchOne(sourceId: string, repoRoot: string, tenantId: string): Promise<number>;
    verifyIntegrity(repoRoot: string): IntegrityReport;
    removeSource(sourceId: string, repoRoot: string): void;
    private fetchSource;
    private fetchGit;
    private fetchHttps;
    private httpGet;
    private materialiseSkill;
    private readManifest;
    private writeManifest;
    private readLockfile;
    private writeLockfile;
    private emptyLockfile;
    private ensureLockEntry;
    private toDashedId;
    private sha256;
}
//# sourceMappingURL=RemoteSkillFetcher.d.ts.map