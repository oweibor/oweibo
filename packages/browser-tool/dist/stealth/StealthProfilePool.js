"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StealthProfilePool = void 0;
class StealthProfilePool {
    profileStore;
    poolSize;
    personas = [];
    constructor(profileStore, poolSize = 5) {
        this.profileStore = profileStore;
        this.poolSize = poolSize;
    }
    async warmUp(tenantId) {
        for (let i = this.personas.length; i < this.poolSize; i++) {
            const personaKey = `stealth-pool-${i}`;
            const profileDir = await this.profileStore
                .acquireProfileDir(tenantId, personaKey);
            this.personas.push({
                personaKey, personaId: personaKey,
                profileKey: personaKey, profileId: personaKey,
                profileDir, lastUsedAt: 0,
            });
        }
    }
    acquire(_tenantId) {
        if (this.personas.length === 0)
            throw new Error('[StealthProfilePool] pool not warmed');
        // LRU rotation
        this.personas.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        const p = this.personas[0];
        p.lastUsedAt = Date.now();
        return p;
    }
}
exports.StealthProfilePool = StealthProfilePool;
//# sourceMappingURL=StealthProfilePool.js.map