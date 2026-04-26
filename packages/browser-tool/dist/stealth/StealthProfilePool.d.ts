import type { IProfileStore } from '@oweibo/core-contracts';
export interface StealthPersona {
    personaKey: string;
    personaId: string;
    profileKey: string;
    profileId: string;
    profileDir: string;
    lastUsedAt: number;
}
export declare class StealthProfilePool {
    private readonly profileStore;
    private readonly poolSize;
    private readonly personas;
    constructor(profileStore: IProfileStore, poolSize?: number);
    warmUp(tenantId: string): Promise<void>;
    acquire(_tenantId?: string): StealthPersona;
}
//# sourceMappingURL=StealthProfilePool.d.ts.map