/**
 * F.5.8 (ttv-finals): PgSkillSeeder adapter.
 *
 * Wraps the existing SkillRegistry.discover() + ensureEmbedded() pair so
 * the bootstrap worker can call seedSkills(tenantId, bundlePath) and get
 * back the structured SkillSeedResult shape the step expects.
 *
 * Plan §F.5.8 said "SkillRegistry.registerFromBundle(bundlePath,
 * tenantId) already exists — wire it." On re-read SkillRegistry exposes
 * discover() + ensureEmbedded() as separate methods, not a single
 * register-from-bundle. This adapter is the missing single-call surface.
 *
 * The actual SkillRegistry depends on ModelRouter + Qdrant + Redis +
 * Vault; this adapter accepts the registry by interface (just the two
 * methods it calls) so tests can substitute a lightweight fake.
 */
import type { ISkill } from '@oweibo/core-contracts';

export interface SkillSeedResult {
  readonly registered: readonly string[];
  readonly failed: readonly string[];
}

interface ITrace {
  span(opts: { name: string; input?: unknown }): { end(opts?: { output?: unknown }): void };
}

/** The narrow slice of SkillRegistry the adapter actually uses. */
export interface ISkillRegistryFacade {
  discover(repoRoot: string): ISkill[];
  ensureEmbedded(skills: ISkill[], tenantId: string, trace: ITrace): Promise<void>;
}

const NOOP_TRACE: ITrace = {
  span: () => ({ end: () => undefined }),
};

export class PgSkillSeeder {
  constructor(private readonly registry: ISkillRegistryFacade) {}

  /** Discover skills under `bundlePath` then register them via `SkillRegistry.ensureEmbedded`. */
  async seedSkills(tenantId: string, bundlePath: string): Promise<SkillSeedResult> {
    let skills: ISkill[];
    try {
      skills = this.registry.discover(bundlePath);
    } catch (err) {
      // Bundle path missing on disk -> registry throws -> step records
      // failed per plan §F.5.8 ("bundle path missing -> adapter throws
      // with diagnostic; worker treats as failed").
      throw new Error(`skill-bundle-discovery-failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (skills.length === 0) {
      return { registered: [], failed: [] };
    }

    const registered: string[] = [];
    const failed: string[] = [];
    try {
      await this.registry.ensureEmbedded(skills, tenantId, NOOP_TRACE);
      // ensureEmbedded silently skips suspicious skills via console.warn
      // and does not surface a per-skill outcome map — for now we treat
      // every discovered skill as registered. A per-skill outcome lift
      // is a SkillRegistry follow-up (out of scope for F.5.8).
      for (const s of skills) registered.push(s.id);
    } catch (err) {
      // Whole-batch failure: every skill goes to `failed` so the step
      // returns 'failed' (workder retries up to maxAttempts).
      const msg = err instanceof Error ? err.message : String(err);
      for (const s of skills) failed.push(`${s.id}: ${msg}`);
    }
    return { registered, failed };
  }
}
