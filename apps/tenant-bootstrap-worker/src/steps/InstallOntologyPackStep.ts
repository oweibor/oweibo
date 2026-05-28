/**
 * D.1 (domain-depth): InstallOntologyPackStep — materializes the ontology
 * pack(s) for the tenant's bound domain(s) into LTM as `domain-fact` and
 * `tool-heuristic` memories tagged `domain:<slug>:ontology` and
 * `domain:<slug>:glossary` / `:named-entity` / `:terminology`.
 *
 * Architecture mirrors the rest of T.2.*: the worker process does NOT
 * import the full OntologyPackRegistry (which depends on core-engine).
 * Instead it accepts an injectable `IOntologyPackInstaller` that knows
 * how to (a) discover which domain(s) apply for this tenant and (b)
 * persist the pack into LTM + record the install in
 * `tenant_ontology_install`.
 *
 * Default (no installer wired): returns `skipped` with reason
 * `feature_flag_off` — matches the T.1 stub semantics and preserves
 * byte-identical-to-today behavior for tenants that don't run with
 * domain depth enabled.
 *
 * Re-runnability: the installer is told the tenant id; it inspects
 * `tenant_ontology_install` and SKIPs domains already at the current
 * pack_version. A pack version bump (D.7 currency hook) is what triggers
 * re-install.
 */
import type {
  IBootstrapStep,
  IBootstrapStepContext,
  StepResult,
} from './IBootstrapStep.js';
import { readBoolFlag } from './flags.js';

export interface OntologyInstallReport {
  /** Domain slugs the installer considered for this tenant. */
  readonly consideredDomains: readonly string[];
  /** (domain, pack_version) pairs newly installed in this run. */
  readonly installed: readonly { readonly domainSlug: string; readonly packVersion: string; readonly entryCount: number }[];
  /** Domains already at the current pack_version (no-op). */
  readonly alreadyCurrent: readonly string[];
}

export interface IOntologyPackInstaller {
  /**
   * Install (or no-op) the ontology pack(s) for the given tenant.
   *
   * The installer is responsible for:
   *   1. Resolving which domains apply (from `tenant_domain_intake` in v1;
   *      from D.6's `tenant_domain_binding` once that lands).
   *   2. Looking up the corresponding `OntologyPack` from the bundled
   *      `OntologyPackRegistry`.
   *   3. Materializing each entry as an LTM memory with the appropriate
   *      tags + importance (per ttv-domain-depth.md §D.1).
   *   4. UPSERTing `tenant_ontology_install` with the installed
   *      (domain_slug, pack_version, entry_count).
   *
   * Implementations MUST be idempotent across re-runs: a tenant already
   * at the current pack_version yields an empty `installed` list.
   */
  install(tenantId: string): Promise<OntologyInstallReport>;
}

export interface InstallOntologyPackStepOptions {
  installer?: IOntologyPackInstaller;
}

export class InstallOntologyPackStep implements IBootstrapStep {
  readonly name = 'install_ontology_pack';

  constructor(private readonly opts: InstallOntologyPackStepOptions = {}) {}

  async execute(ctx: IBootstrapStepContext): Promise<StepResult> {
    if (!readBoolFlag(ctx.features, 'tenant.bootstrap.install_ontology_pack.enabled')) {
      return { status: 'skipped', skipReason: 'feature_flag_off' };
    }
    if (!this.opts.installer) {
      ctx.logger.info('InstallOntologyPackStep: installer not wired; skipping', {
        tenantId: ctx.tenantId,
      });
      return { status: 'skipped', skipReason: 'feature_flag_off' };
    }

    let report: OntologyInstallReport;
    try {
      report = await this.opts.installer.install(ctx.tenantId);
    } catch (err) {
      ctx.logger.error('InstallOntologyPackStep: installer threw', {
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    ctx.logger.info('InstallOntologyPackStep: install complete', {
      tenantId: ctx.tenantId,
      considered: report.consideredDomains,
      installed: report.installed.map((i) => `${i.domainSlug}@${i.packVersion}`),
      alreadyCurrent: report.alreadyCurrent,
    });

    // If the installer considered no domains (tenant has no classified
    // domain yet), report as skipped so the orchestrator's
    // mode_too_low / no_content semantics surface cleanly.
    if (report.consideredDomains.length === 0) {
      return { status: 'skipped', skipReason: 'no_content' };
    }
    return { status: 'ok' };
  }
}
