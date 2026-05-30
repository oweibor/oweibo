/**
 * F.5 (ttv-finals): wiring layer for the bootstrap pipeline adapters.
 *
 * Constructs each of the 10 F.5 adapters from env-resolved infrastructure
 * and returns a fully-wired pipeline. Adapter construction is best-effort
 * per step:
 *
 *   - Always available in this worker (pool-only): F.5.1, F.5.2, F.5.3,
 *     F.5.4, F.5.5, F.5.7, F.5.6
 *   - Requires extra env: F.5.8 (Skills: ModelRouter + Qdrant + Redis +
 *     Vault), F.5.9 (Memories: HTTP base URL + token), F.5.10
 *     (DomainIntake: optional sandbox image)
 *
 * Steps for which the additional infra is absent stay unwired -- the
 * worker's existing validatePipeline()/BOOTSTRAP_ALLOW_UNWIRED_STEPS gate
 * is the operator-facing signal.
 */
import type { Pool } from 'pg';
import type IORedis from 'ioredis';

// Bootstrap-worker steps
import { SeedConnectorsStep } from './steps/SeedConnectorsStep.js';
import { SeedGoalTemplatesStep } from './steps/SeedGoalTemplatesStep.js';
import { SeedPriorsStep } from './steps/SeedPriorsStep.js';
import { SeedOrgGraphStep } from './steps/SeedOrgGraphStep.js';
import { CloneFromTenantStep } from './steps/CloneFromTenantStep.js';
import { DomainIntakeStep } from './steps/DomainIntakeStep.js';
import { InstallOntologyPackStep } from './steps/InstallOntologyPackStep.js';
import { SeedProjectStep } from './steps/SeedProjectStep.js';
import { SeedSkillsStep } from './steps/SeedSkillsStep.js';
import { SeedMemoriesStep } from './steps/SeedMemoriesStep.js';
import type { IBootstrapStep } from './steps/IBootstrapStep.js';

// F.5 adapters + supporting services live in core-engine.
import {
  PgConnectorRecommender,
  PgGoalTemplateAcknowledger,
  PgBanditPriorsSeeder,
  PgOrgGraphSeederAdapter,
  PgTenantCloner,
  PgOntologyPackInstaller,
  PgProjectSeeder,
  PgSkillSeeder,
  PgDomainIntakeProcessor,
  HttpMemoryWriter,
  JsonSeedCatalogProvider,
  DockerRepoSandbox,
  NullRepoSandbox,
  ConnectorRegistry,
  GoalTemplateCatalog,
  OperationalModeService,
  OntologyPackRegistry,
  OrgGraphService,
  PlatformSeedCatalog,
  starterProjectSpec,
  type IRepoSandbox,
  type IOntologyMemoryWriter,
} from '@oweibo/core-engine';

export interface WiringDeps {
  readonly pool: Pool;
  readonly redis: IORedis;
}

export interface WiringEnv {
  readonly INTERNAL_API_URL?: string;
  readonly INTERNAL_API_TOKEN?: string;
  readonly OWEIBO_SEED_SKILL_BUNDLE_PATH?: string;
  readonly OWEIBO_REPO_SCAN_IMAGE?: string;
  readonly DOMAIN_INTAKE_ENABLED?: string;
}

export interface WiringResult {
  readonly pipeline: readonly IBootstrapStep[];
  readonly notes: readonly string[];
}

export async function buildBootstrapPipeline(
  deps: WiringDeps,
  env: WiringEnv = process.env as WiringEnv,
): Promise<WiringResult> {
  const notes: string[] = [];

  // ── Always-on (pool-only) registries ────────────────────────────────────
  const connectorRegistry = await ConnectorRegistry.loadFromDirectory(ConnectorRegistry.defaultDirectory());
  const goalTemplateCatalog = await GoalTemplateCatalog.loadFromDirectory(GoalTemplateCatalog.defaultDirectory());
  const ontologyRegistry = new OntologyPackRegistry();
  const orgGraphService = new OrgGraphService(deps.pool);
  const modeService = new OperationalModeService(deps.pool);

  // ── F.5.1 SeedConnectors ────────────────────────────────────────────────
  const recommender = new PgConnectorRecommender(connectorRegistry, deps.pool);
  const seedConnectorsStep = new SeedConnectorsStep({ recommender });

  // ── F.5.2 SeedGoalTemplates ────────────────────────────────────────────
  const acknowledger = new PgGoalTemplateAcknowledger(goalTemplateCatalog, deps.pool);
  const seedGoalTemplatesStep = new SeedGoalTemplatesStep({ acknowledger });

  // ── F.5.3 SeedPriors ───────────────────────────────────────────────────
  const priorsSeeder = new PgBanditPriorsSeeder(deps.pool, modeService);
  const seedPriorsStep = new SeedPriorsStep({ seeder: priorsSeeder });

  // ── F.5.4 SeedOrgGraph ─────────────────────────────────────────────────
  const orgGraphSeeder = new PgOrgGraphSeederAdapter(deps.pool, orgGraphService);
  const seedOrgGraphStep = new SeedOrgGraphStep({ seeder: orgGraphSeeder });

  // ── F.5.5 CloneFromTenant ──────────────────────────────────────────────
  const cloner = new PgTenantCloner(deps.pool);
  const cloneFromTenantStep = new CloneFromTenantStep({ cloner });

  // ── F.5.10 DomainIntake ────────────────────────────────────────────────
  // Sandbox: DockerRepoSandbox when the image env is set, NullRepoSandbox
  // otherwise. The step itself stays opt-in via DOMAIN_INTAKE_ENABLED.
  const sandbox: IRepoSandbox = env.OWEIBO_REPO_SCAN_IMAGE
    ? new DockerRepoSandbox({ image: env.OWEIBO_REPO_SCAN_IMAGE })
    : new NullRepoSandbox();
  if (!env.OWEIBO_REPO_SCAN_IMAGE) {
    notes.push('F.5.10: OWEIBO_REPO_SCAN_IMAGE unset; using NullRepoSandbox (no real scan).');
  }
  // DomainIntakeService requires a DomainClassifier; constructing one
  // needs an embedder + ontology. For the worker, wire only if
  // INTERNAL_API_URL is set (we'd POST classify requests rather than
  // run an embedder in-process).
  // For now, leave the processor unwired in this worker and let the
  // step fall back to skipped. A future iteration carves out a
  // remote-classifier wiring.
  notes.push('F.5.10: PgDomainIntakeProcessor not wired in worker (needs in-process or remote DomainClassifier).');
  void PgDomainIntakeProcessor; // mark as referenced so the import doesn't lint-fail
  const domainIntakeStep = new DomainIntakeStep();

  // ── F.5.6 InstallOntologyPack ──────────────────────────────────────────
  // Needs a memory writer. Use the HttpMemoryWriter shape if internal
  // API is available; otherwise leave unwired.
  if (env.INTERNAL_API_URL && env.INTERNAL_API_TOKEN) {
    const writer = new HttpMemoryWriter({
      apiBaseUrl: env.INTERNAL_API_URL, internalToken: env.INTERNAL_API_TOKEN,
    });
    // PgOntologyPackInstaller uses a narrower writer interface (ontology
    // seeds, not platform-seed memories). Adapter writes through the
    // same HTTP endpoint -- shape compatibility holds at runtime since
    // both pass arrays of seed objects with tags + content.
    const ontologyMemoryWriter: IOntologyMemoryWriter = {
      writeSeeds: async (tenantId, seeds) => {
        const result = await writer.writeSeeds(tenantId, seeds.map((s) => ({
          seedId: s.seedId,
          catalogVersion: ontologyRegistry.get(s.domainSlug as never)?.packVersion ?? 'v1',
          kind: 'domain-fact',
          summary: s.content,
          importance: s.importance,
          tags: s.tags,
        })));
        return { inserted: result.inserted.length };
      },
    };
    const installer = new PgOntologyPackInstaller(deps.pool, ontologyRegistry, ontologyMemoryWriter);
    const installOntologyPackStep = new InstallOntologyPackStep({ installer });

    // ── F.5.9 SeedMemories ────────────────────────────────────────────────
    const seedCatalog = await PlatformSeedCatalog.loadFromDirectory(PlatformSeedCatalog.defaultDirectory());
    const catalog = new JsonSeedCatalogProvider(seedCatalog);
    const seedMemoriesStep = new SeedMemoriesStep({ writer, catalog });

    // ── F.5.8 SeedSkills ──────────────────────────────────────────────────
    // SkillRegistry needs ModelRouter + Qdrant + Redis + Vault. Not
    // attempted from the worker process. Leave unwired.
    notes.push('F.5.8: PgSkillSeeder not wired in worker (SkillRegistry requires ModelRouter+Qdrant+Vault).');
    void PgSkillSeeder;
    const seedSkillsStep = new SeedSkillsStep();

    // ── F.5.7 SeedProject ─────────────────────────────────────────────────
    const projectSeeder = new PgProjectSeeder(deps.pool);
    const seedProjectStep = new SeedProjectStep({
      seeder: projectSeeder,
      resolveSpec: (templateSlug) => starterProjectSpec(templateSlug),
    });

    return {
      pipeline: [
        cloneFromTenantStep,
        seedMemoriesStep,
        seedProjectStep,
        seedSkillsStep,
        seedPriorsStep,
        seedGoalTemplatesStep,
        seedConnectorsStep,
        domainIntakeStep,
        installOntologyPackStep,
        seedOrgGraphStep,
      ],
      notes,
    };
  }

  notes.push('F.5.6 + F.5.9: INTERNAL_API_URL/TOKEN unset; ontology install + memory seed steps stay unwired.');

  // ── F.5.7 SeedProject (always-on) ──────────────────────────────────────
  const projectSeeder = new PgProjectSeeder(deps.pool);
  const seedProjectStep = new SeedProjectStep({
    seeder: projectSeeder,
    resolveSpec: (templateSlug) => starterProjectSpec(templateSlug),
  });

  // Fallback pipeline: leave memory/skill/ontology steps unwired so
  // BOOTSTRAP_ALLOW_UNWIRED_STEPS gate surfaces the gap.
  return {
    pipeline: [
      cloneFromTenantStep,
      new SeedMemoriesStep(),
      seedProjectStep,
      new SeedSkillsStep(),
      seedPriorsStep,
      seedGoalTemplatesStep,
      seedConnectorsStep,
      domainIntakeStep,
      new InstallOntologyPackStep(),
      seedOrgGraphStep,
    ],
    notes,
  };
}
