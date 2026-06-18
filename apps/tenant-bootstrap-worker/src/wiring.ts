/**
 * F.5 (ttv-finals): wiring layer for the bootstrap pipeline adapters.
 *
 * Constructs each of the 10 F.5 adapters from env-resolved infrastructure
 * and returns a fully-wired pipeline. Adapter construction is best-effort
 * per step:
 *
 *   - Always available in this worker (pool-only): F.5.1, F.5.2, F.5.3,
 *     F.5.4, F.5.5, F.5.7
 *   - Requires INTERNAL_API_URL + INTERNAL_API_TOKEN: F.5.6 + F.5.9
 *     (memory/ontology writes), F.5.8 (skills -- via HttpSkillSeeder
 *     when OWEIBO_SEED_SKILL_BUNDLE_PATH is also set), F.5.10
 *     (DomainIntake -- HttpDomainClassifier handles classification,
 *     PgDomainIntakeProcessor still owns the local state machine)
 *
 * Steps for which the additional env is absent stay unwired -- the
 * worker's existing validatePipeline()/BOOTSTRAP_ALLOW_UNWIRED_STEPS gate
 * is the operator-facing signal. All 10 adapters reach wired in production
 * once INTERNAL_API_URL + INTERNAL_API_TOKEN + OWEIBO_SEED_SKILL_BUNDLE_PATH
 * are set (B.11 acceptance from ttv_finals_followups.md).
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
  PgDomainIntakeProcessor,
  HttpMemoryWriter,
  HttpSkillSeeder,
  HttpDomainClassifier,
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
  // B.2: HttpDomainClassifier outsources the embedding+classification
  // step to the server (which holds the embedder + ontology). The worker
  // keeps the Postgres state machine local via PgDomainIntakeProcessor.
  // The step is additionally gated by DOMAIN_INTAKE_ENABLED (off by
  // default until B.3 security review).
  let domainIntakeStep: DomainIntakeStep;
  if (env.INTERNAL_API_URL && env.INTERNAL_API_TOKEN) {
    const httpClassifier = new HttpDomainClassifier({
      apiBaseUrl: env.INTERNAL_API_URL,
      internalToken: env.INTERNAL_API_TOKEN,
    });
    const processor = new PgDomainIntakeProcessor(deps.pool, httpClassifier, sandbox);
    domainIntakeStep = new DomainIntakeStep({ processor });
    notes.push('F.5.10: PgDomainIntakeProcessor wired via HttpDomainClassifier.');
  } else {
    notes.push('F.5.10: INTERNAL_API_URL/TOKEN unset; DomainIntakeStep stays unwired.');
    domainIntakeStep = new DomainIntakeStep();
  }

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
    //
    // F.5 review fix: preserve the per-seed kind ('glossary' /
    // 'named-entity' / 'terminology') by mapping to a corresponding
    // MemoryKind value instead of flattening every seed to
    // 'domain-fact'. Downstream consumers that filter memories by
    // kind would otherwise see zero rows for any of the three
    // sub-kinds.
    const ontologyMemoryWriter: IOntologyMemoryWriter = {
      writeSeeds: async (tenantId, seeds) => {
        const result = await writer.writeSeeds(tenantId, seeds.map((s) => {
          // F.7 review: fail fast if the seed's domainSlug isn't in the
          // registry instead of silently stamping 'v1'. Seeds are rendered
          // by PgOntologyPackInstaller from packs already in the registry,
          // so a miss here indicates a registry-reload or pack-retirement
          // race -- preferable to surface it than to write divergent
          // catalogVersion metadata.
          const pack = ontologyRegistry.get(s.domainSlug as never);
          if (!pack) {
            throw new Error(`ontologyMemoryWriter: unknown domainSlug ${JSON.stringify(s.domainSlug)} (seedId=${s.seedId})`);
          }
          return {
            seedId: s.seedId,
            catalogVersion: pack.packVersion,
            kind: ontologyKindToMemoryKind(s.kind),
            summary: s.content,
            importance: s.importance,
            tags: s.tags,
          };
        }));
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
    // B.1: HttpSkillSeeder outsources discover+ensureEmbedded to the
    // server-side route (which holds ModelRouter+Qdrant+Redis+Vault).
    // Wired when both internal API env AND a bundle path are present.
    let seedSkillsStep: SeedSkillsStep;
    if (env.OWEIBO_SEED_SKILL_BUNDLE_PATH) {
      const httpSeeder = new HttpSkillSeeder({
        apiBaseUrl: env.INTERNAL_API_URL!,
        internalToken: env.INTERNAL_API_TOKEN!,
      });
      seedSkillsStep = new SeedSkillsStep({
        seeder: httpSeeder,
        bundlePath: env.OWEIBO_SEED_SKILL_BUNDLE_PATH,
      });
      notes.push('F.5.8: SeedSkillsStep wired via HttpSkillSeeder.');
    } else {
      notes.push('F.5.8: OWEIBO_SEED_SKILL_BUNDLE_PATH unset; SeedSkillsStep stays unwired.');
      seedSkillsStep = new SeedSkillsStep();
    }

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

/**
 * Map an OntologyMemorySeed.kind ('glossary' | 'named-entity' |
 * 'terminology') onto a MemoryKind that the downstream memory store
 * indexes. The split is load-bearing: 'glossary' and 'named-entity'
 * become 'domain-fact' (factual knowledge), while 'terminology'
 * becomes 'tool-heuristic' (style guidance applied at artifact-time).
 *
 * Without this mapping every kind was flattened to 'domain-fact',
 * which meant downstream consumers filtering by kind could never
 * distinguish a vocabulary rule from a regulator name.
 */
function ontologyKindToMemoryKind(seedKind: 'glossary' | 'named-entity' | 'terminology'): string {
  switch (seedKind) {
    case 'glossary':     return 'domain-fact';
    case 'named-entity': return 'domain-fact';
    case 'terminology':  return 'tool-heuristic';
  }
}
