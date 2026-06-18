/**
 * T.2.c: SeedSkillsStep — registers the platform-curated SKILL.md bundle
 * with the tenant's SkillRegistry and embeds it into Qdrant.
 *
 * Mirrors the architecture of T.2.a / T.2.b — accepts an injectable
 * ISkillSeeder so the worker process need not import the heavy core-engine
 * SkillRegistry (which depends on ModelRouter, Qdrant, Redis, Vault). The
 * default (no seeder wired) returns 'skipped', matching the T.1 stub.
 *
 * Idempotency: implementations should be safe to re-run — re-registering
 * an unchanged skill is a no-op against Qdrant when the contentHash matches.
 *
 * Bundle path resolution: callers either inject a static path (test) or
 * read OWEIBO_SEED_SKILL_BUNDLE_PATH from the worker's env (production).
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface SkillSeedResult {
  /** Skill ids successfully registered (or already present). */
  readonly registered: readonly string[];
  /** Skill ids that failed validation / governance / embedding. */
  readonly failed: readonly string[];
}

export interface ISkillSeeder {
  /**
   * Discover, embed, and register every SKILL.md under `bundlePath` for
   * `tenantId`. Implementations must be idempotent and must NOT throw on
   * per-skill validation/governance failure — capture them in `failed`.
   */
  seedSkills(tenantId: string, bundlePath: string): Promise<SkillSeedResult>;
}

export interface SeedSkillsStepOptions {
  seeder?: ISkillSeeder;
  /** Path to the seed bundle root (the dir whose children are `<skill-name>/SKILL.md`). */
  bundlePath?: string;
}

export class SeedSkillsStep implements IBootstrapStep {
  readonly name = 'seed_skills';

  constructor(private readonly opts: SeedSkillsStepOptions = {}) {}

  isWired(): boolean {
    return Boolean(this.opts.seeder
      && (this.opts.bundlePath || process.env['OWEIBO_SEED_SKILL_BUNDLE_PATH']));
  }

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_skills.enabled')) {
      return 'skipped';
    }
    const bundlePath = this.opts.bundlePath ?? process.env['OWEIBO_SEED_SKILL_BUNDLE_PATH'];
    if (!this.opts.seeder || !bundlePath) {
      ctx.logger.info('SeedSkillsStep: seeder or bundle path not wired; skipping', {
        tenantId: ctx.tenantId,
        hasSeeder: Boolean(this.opts.seeder),
        hasBundlePath: Boolean(bundlePath),
      });
      return 'skipped';
    }

    let result: SkillSeedResult;
    try {
      result = await this.opts.seeder.seedSkills(ctx.tenantId, bundlePath);
    } catch (err) {
      ctx.logger.error('SeedSkillsStep: seeder threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedSkillsStep: bundle applied', {
      tenantId: ctx.tenantId,
      registered: result.registered.length,
      failed: result.failed.length,
    });

    if (result.failed.length > 0 && result.registered.length === 0) {
      return 'failed';
    }
    return 'ok';
  }
}
