/**
 * T.2.b: SeedProjectStep — installs the starter Project so MemoryWarmer
 * channel 2 (project-scope) returns non-empty on day-one tasks.
 *
 * Like SeedMemoriesStep, the worker accepts an injectable IProjectSeeder
 * rather than instantiating ProjectRegistry directly (which lives in
 * core-engine and depends on Redis). When the writer/spec is not wired, the
 * step returns 'skipped' — preserving the T.1 stub behavior. Tests pass an
 * in-memory seeder.
 *
 * Idempotency: the seeder is expected to check whether a tenant already has
 * a starter project (e.g. by tag `seed:starter-project`) and either reuse it
 * or skip. Either result counts as 'ok'.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface StarterProjectInvariants {
  readonly name: string;
  readonly description: string;
  readonly invariants: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

export type SeederStatus = 'inserted' | 'already_present' | 'failed';

export interface IProjectSeeder {
  /**
   * Install the starter project for `tenantId`. Implementations must be
   * idempotent — repeated calls for the same tenant must not produce
   * duplicate starter projects.
   */
  seedStarterProject(tenantId: string, spec: StarterProjectInvariants): Promise<{
    readonly projectId: string | null;
    readonly status: SeederStatus;
    readonly reason?: string;
  }>;
}

/** Template-slug → spec resolver. */
export type ISpecResolver = (templateSlug: string) => StarterProjectInvariants;

export interface SeedProjectStepOptions {
  seeder?: IProjectSeeder;
  resolveSpec?: ISpecResolver;
}

export class SeedProjectStep implements IBootstrapStep {
  readonly name = 'seed_project';
  constructor(private readonly opts: SeedProjectStepOptions = {}) {}

  isWired(): boolean {
    return Boolean(this.opts.seeder && this.opts.resolveSpec);
  }

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.seed_project.enabled')) {
      return 'skipped';
    }
    if (!this.opts.seeder || !this.opts.resolveSpec) {
      ctx.logger.info('SeedProjectStep: seeder or spec resolver not wired; skipping', {
        tenantId: ctx.tenantId,
        hasSeeder: Boolean(this.opts.seeder),
        hasResolver: Boolean(this.opts.resolveSpec),
      });
      return 'skipped';
    }

    const spec = this.opts.resolveSpec(ctx.templateSlug);
    let result: Awaited<ReturnType<IProjectSeeder['seedStarterProject']>>;
    try {
      result = await this.opts.seeder.seedStarterProject(ctx.tenantId, spec);
    } catch (err) {
      ctx.logger.error('SeedProjectStep: seeder threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('SeedProjectStep: starter project applied', {
      tenantId: ctx.tenantId,
      projectId: result.projectId,
      status: result.status,
    });

    if (result.status === 'failed') return 'failed';
    return 'ok';
  }
}
