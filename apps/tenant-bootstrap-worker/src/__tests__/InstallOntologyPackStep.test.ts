/**
 * D.1 — InstallOntologyPackStep tests.
 */
import type { Pool } from 'pg';
import {
  InstallOntologyPackStep,
  type IOntologyPackInstaller,
  type OntologyInstallReport,
} from '../steps/InstallOntologyPackStep.js';
import type { IBootstrapStepContext } from '../steps/IBootstrapStep.js';

const silentLogger = {
  info:  () => undefined,
  warn:  () => undefined,
  error: () => undefined,
};

function ctx(overrides: Partial<IBootstrapStepContext> = {}): IBootstrapStepContext {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    templateSlug: 'default',
    pool: {} as Pool,
    logger: silentLogger,
    features: overrides.features ?? {},
    seedCohort: 'seeded',
    ...overrides,
  } as IBootstrapStepContext;
}

const ENABLED_FEATURES = {
  'tenant.bootstrap.install_ontology_pack.enabled': true,
} as const;

function installerWith(report: OntologyInstallReport): IOntologyPackInstaller {
  return { install: jest.fn().mockResolvedValue(report) };
}

describe('InstallOntologyPackStep', () => {
  it('skips with feature_flag_off when the flag is off', async () => {
    const step = new InstallOntologyPackStep({
      installer: installerWith({ consideredDomains: ['fintech'], installed: [], alreadyCurrent: [] }),
    });
    const r = await step.execute(ctx());
    expect(r).toEqual({ status: 'skipped', skipReason: 'feature_flag_off' });
  });

  it('skips with feature_flag_off when the installer is not wired', async () => {
    const step = new InstallOntologyPackStep({});
    const r = await step.execute(ctx({ features: ENABLED_FEATURES }));
    expect(r).toEqual({ status: 'skipped', skipReason: 'feature_flag_off' });
  });

  it("returns 'ok' when installer reports installed entries", async () => {
    const installer = installerWith({
      consideredDomains: ['fintech'],
      installed: [{ domainSlug: 'fintech', packVersion: '1.0.0-stub', entryCount: 23 }],
      alreadyCurrent: [],
    });
    const step = new InstallOntologyPackStep({ installer });
    const r = await step.execute(ctx({ features: ENABLED_FEATURES }));
    expect(r).toEqual({ status: 'ok' });
    expect(installer.install).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it("returns 'ok' when domain is already at current pack_version (idempotent re-run)", async () => {
    const installer = installerWith({
      consideredDomains: ['fintech'],
      installed: [],
      alreadyCurrent: ['fintech'],
    });
    const step = new InstallOntologyPackStep({ installer });
    expect(await step.execute(ctx({ features: ENABLED_FEATURES }))).toEqual({ status: 'ok' });
  });

  it("returns skipped with skipReason 'no_content' when no domains apply", async () => {
    const installer = installerWith({
      consideredDomains: [],
      installed: [],
      alreadyCurrent: [],
    });
    const step = new InstallOntologyPackStep({ installer });
    const r = await step.execute(ctx({ features: ENABLED_FEATURES }));
    expect(r).toEqual({ status: 'skipped', skipReason: 'no_content' });
  });

  it("returns 'failed' when the installer throws", async () => {
    const installer: IOntologyPackInstaller = {
      install: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const step = new InstallOntologyPackStep({ installer });
    const r = await step.execute(ctx({ features: ENABLED_FEATURES }));
    expect(r.status).toBe('failed');
    expect(r.message).toBe('boom');
  });
});
