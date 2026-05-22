/**
 * T.2.g: DomainIntakeStep — opt-in step that processes a tenant's submitted
 * intake (interview answers, primer docs, repo signals), classifies the
 * tenant's domain, and persists the recommendations.
 *
 * The step is opt-in: it does nothing unless the tenant has explicitly
 * submitted the intake wizard (tenant_domain_intake.intake_state =
 * 'requested'). For tenants that never run intake, the step returns
 * 'skipped' on every invocation — preserving today's behaviour.
 *
 * Architecture mirrors the rest of T.2.*: an injectable IDomainIntakeProcessor
 * does the heavy lifting (classifier, memory writes, recommendation update).
 * The worker process does not import the full DomainIntakeService directly.
 */
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export type IntakeStateLookup = 'pending' | 'requested' | 'processing' | 'complete' | 'skipped' | 'failed';

export interface IntakeProcessResult {
  readonly classifiedDomain: string | null;
  readonly classifiedConfidence: number | null;
  readonly recommendedTemplate: string | null;
  readonly recommendedConnectors: readonly string[];
  readonly recommendedSeedSkills: readonly string[];
}

export interface IDomainIntakeProcessor {
  /** Look up the current intake_state for the tenant. */
  loadState(tenantId: string): Promise<IntakeStateLookup | 'absent'>;
  /** Process the requested intake and persist recommendations. Implementations
   *  must transition intake_state through 'processing' → 'complete'/'failed'. */
  process(tenantId: string): Promise<IntakeProcessResult>;
}

export interface DomainIntakeStepOptions {
  processor?: IDomainIntakeProcessor;
}

export class DomainIntakeStep implements IBootstrapStep {
  readonly name = 'domain_intake';

  constructor(private readonly opts: DomainIntakeStepOptions = {}) {}

  async execute(ctx: IBootstrapStepContext): Promise<StepStatus> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.domain_intake.enabled')) {
      return 'skipped';
    }
    if (!this.opts.processor) {
      ctx.logger.info('DomainIntakeStep: processor not wired; skipping', {
        tenantId: ctx.tenantId,
      });
      return 'skipped';
    }

    const state = await this.opts.processor.loadState(ctx.tenantId).catch(() => 'absent' as const);
    if (state === 'absent' || state === 'pending' || state === 'skipped' || state === 'complete') {
      ctx.logger.info('DomainIntakeStep: no requested intake; skipping', {
        tenantId: ctx.tenantId,
        state,
      });
      return 'skipped';
    }
    if (state === 'failed') {
      // A prior intake attempt failed; the worker retries up to maxAttempts
      // via BootstrapWorker — return 'failed' so the retry budget is honored.
      return 'failed';
    }

    let result: IntakeProcessResult;
    try {
      result = await this.opts.processor.process(ctx.tenantId);
    } catch (err) {
      ctx.logger.error('DomainIntakeStep: processor threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }

    ctx.logger.info('DomainIntakeStep: intake processed', {
      tenantId: ctx.tenantId,
      classifiedDomain: result.classifiedDomain,
      classifiedConfidence: result.classifiedConfidence,
      recommendedConnectors: result.recommendedConnectors,
    });
    return 'ok';
  }
}
