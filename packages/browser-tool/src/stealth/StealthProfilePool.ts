// packages/browser-tool/src/stealth/StealthProfilePool.ts
// Pre-warmed pool of stealth personas (§5.7) — fingerprint randomization, persona aging.
// Minimal implementation: tracks N pre-baked profile dirs and rotates them.
import type { IProfileStore } from '@oweibo/core-contracts';

export interface StealthPersona {
  personaKey: string;
  personaId:  string;
  profileKey: string;
  profileId:  string;
  profileDir: string;
  lastUsedAt: number;
}

export class StealthProfilePool {
  private readonly personas: StealthPersona[] = [];

  constructor(
    private readonly profileStore: IProfileStore,
    private readonly poolSize: number = 5,
  ) {}

  async warmUp(tenantId: string): Promise<void> {
    for (let i = this.personas.length; i < this.poolSize; i++) {
      const personaKey = `stealth-pool-${i}`;
      const profileDir = await (this.profileStore as unknown as { acquireProfileDir(t: string, k: string): Promise<string> })
        .acquireProfileDir(tenantId, personaKey);
      this.personas.push({
        personaKey, personaId: personaKey,
        profileKey: personaKey, profileId: personaKey,
        profileDir, lastUsedAt: 0,
      });
    }
  }

  acquire(_tenantId?: string): StealthPersona {
    if (this.personas.length === 0) throw new Error('[StealthProfilePool] pool not warmed');
    // LRU rotation
    this.personas.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const p = this.personas[0]!;
    p.lastUsedAt = Date.now();
    return p;
  }
}
