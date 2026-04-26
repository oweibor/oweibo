import type { ISkill } from '@oweibo/core-contracts';
type QdrantClient = any;
import type { Redis } from 'ioredis';
import type { ModelRouter } from '../../infrastructure/ModelRouter.js';
import type { VaultClient } from '../../infrastructure/VaultClient.js';
interface ITrace {
    span(opts: {
        name: string;
        input?: unknown;
    }): {
        end(opts?: {
            output?: unknown;
        }): void;
    };
}
export declare class SkillRegistry {
    private readonly modelRouter;
    private readonly qdrant;
    private readonly redis;
    private readonly vault;
    private static readonly MAX_FILE_SIZE_BYTES;
    private static readonly MAX_CONTENT_CHARS;
    private static readonly QDRANT_COLLECTION;
    private static readonly SKILL_DIRS;
    private config;
    private configLoaded;
    constructor(modelRouter: ModelRouter, qdrant: QdrantClient, redis: Redis, vault: VaultClient);
    private getConfig;
    discover(repoRoot: string): ISkill[];
    discoverCached(repoRoot: string, tenantId: string): Promise<ISkill[]>;
    ensureEmbedded(skills: ISkill[], tenantId: string, trace: ITrace): Promise<void>;
    selectForTask(taskInstruction: string, skills: ISkill[], tenantId: string, trace: ITrace, taskMode?: 'general-coding' | 'factory'): Promise<string>;
    listAll(repoRoot: string): ISkill[];
    /**
     * search — returns skills whose name, description, or tags contain the query
     * string (case-insensitive). Used by the gc:skill tool's 'search' op.
     */
    search(repoRoot: string, query: string): ISkill[];
    /**
     * getByName — returns the first skill whose name exactly matches (case-insensitive),
     * or null if not found. Used by the gc:skill tool's 'activate' op.
     */
    getByName(repoRoot: string, name: string): ISkill | null;
    watch(repoRoot: string, tenantId: string): () => void;
    private parseSkillFile;
    private parseFrontmatter;
    private extractFirstParagraph;
    private formatSkillsBlock;
    private enforceTokenBudget;
    private containsSuspiciousPatterns;
    private runGovernanceScan;
    private ensureQdrantCollection;
    private getRepoHash;
    private toDashedId;
    private skillIdToUuid;
}
export {};
//# sourceMappingURL=SkillRegistry.d.ts.map