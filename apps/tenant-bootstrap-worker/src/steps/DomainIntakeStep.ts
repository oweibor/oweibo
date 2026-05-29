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
  /**
   * Process the requested intake and persist recommendations.
   * Implementations must transition intake_state through 'processing' →
   * 'complete'/'failed'.
   *
   * Audit-fix (T.2.g): when the processor consumes a tenant-supplied
   * git URL (repo scan), it MUST honor the following limits — these
   * are the platform's security contract for arbitrary-tenant code
   * processing:
   *
   *   1. Run in a SEPARATE process / container — not the worker
   *      process itself. seccomp profile with default-deny syscalls.
   *      No network access during scan (cannot exfiltrate via
   *      package-install hooks).
   *   2. Hard timeout: 120s wall clock per scan.
   *   3. Clone depth = 1, max 1 GB tree size, max 100k files.
   *   4. File extension allowlist (.ts, .tsx, .js, .py, .go, .rb,
   *      .java, .rs, .md, .json, .yaml, .yml, .toml, .lock).
   *      Everything else is skipped (no LFS, no binaries, no
   *      executables in PATH).
   *   5. Strip symlinks before analysis — prevent traversal of
   *      /proc, /sys, parent-of-clone directories.
   *   6. Never execute repo content (no `npm install`, no
   *      `python setup.py`, no postinstall hooks).
   *
   * Documented here rather than in a separate contract because the
   * interface boundary is the natural enforcement point: the worker
   * does not invoke `process()` knowing what the implementation
   * does — review at PR-time confirms the implementor honored these
   * limits. Implementations should add an integration test that
   * exercises a malicious-fixture repo and verifies the sandbox
   * containment.
   */
  process(tenantId: string): Promise<IntakeProcessResult>;
}

export interface DomainIntakeStepOptions {
  processor?: IDomainIntakeProcessor;
}

export class DomainIntakeStep implements IBootstrapStep {
  readonly name = 'domain_intake';

  constructor(private readonly opts: DomainIntakeStepOptions = {}) {}

  isWired(): boolean {
    return Boolean(this.opts.processor);
  }

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
