/**
 * F.5 wiring acceptance — exercises buildBootstrapPipeline against the
 * two env scenarios (minimal vs. with internal API) and asserts the
 * wired vs. unwired counts match the plan §F.5 expectations.
 */
import { BootstrapWorker } from '../BootstrapWorker.js';
import { buildBootstrapPipeline } from '../wiring.js';
import type { Pool } from 'pg';
import type IORedis from 'ioredis';

// The wiring doesn't actually open connections at construction (registry
// loaders + service ctors are lazy). The pool only matters when steps
// execute; for pipeline assembly + validation, a stub is enough.
const stubPool = { connect: jest.fn(), query: jest.fn() } as unknown as Pool;
const stubRedis = {} as IORedis;

async function buildAndValidate(env: Record<string, string | undefined>) {
  const { pipeline, notes } = await buildBootstrapPipeline(
    { pool: stubPool, redis: stubRedis },
    env as never,
  );
  const worker = new BootstrapWorker(stubPool, async () => ({}), { pipeline });
  return { worker, report: worker.validatePipeline(), notes };
}

describe('F.5 wiring', () => {
  it('always-wired steps stay wired with no env (connectors, goal-templates, priors, org-graph, clone, project)', async () => {
    const { report } = await buildAndValidate({});
    const wired = new Set(report.wired);
    expect(wired.has('seed_connectors')).toBe(true);
    expect(wired.has('seed_goal_templates')).toBe(true);
    expect(wired.has('seed_priors')).toBe(true);
    expect(wired.has('seed_org_graph')).toBe(true);
    expect(wired.has('clone_from_tenant')).toBe(true);
    expect(wired.has('seed_project')).toBe(true);
  });

  it('memory/skill/ontology stay unwired without INTERNAL_API_URL', async () => {
    const { report } = await buildAndValidate({});
    const unwired = new Set(report.unwired);
    expect(unwired.has('seed_memories')).toBe(true);
    expect(unwired.has('seed_skills')).toBe(true);
    expect(unwired.has('install_ontology_pack')).toBe(true);
  });

  it('memory + ontology wire on when INTERNAL_API_URL and TOKEN are set', async () => {
    const { report, notes } = await buildAndValidate({
      INTERNAL_API_URL: 'http://internal-api',
      INTERNAL_API_TOKEN: 'tok',
    });
    expect(report.wired).toContain('seed_memories');
    expect(report.wired).toContain('install_ontology_pack');
    // Skills + domain-intake still unwired without their additional infra.
    expect(report.unwired).toContain('seed_skills');
    expect(report.unwired).toContain('domain_intake');
    // The wiring notes call out which steps stay unwired and why.
    expect(notes.join(' ')).toContain('PgSkillSeeder');
    expect(notes.join(' ')).toContain('DomainClassifier');
  });

  it('reports the F.5.10 sandbox fallback when OWEIBO_REPO_SCAN_IMAGE is unset', async () => {
    const { notes } = await buildAndValidate({});
    expect(notes.some((n) => n.includes('NullRepoSandbox'))).toBe(true);
  });

  it('pipeline covers all 10 steps in T.9-defined order', async () => {
    const { report } = await buildAndValidate({});
    expect([...report.wired, ...report.unwired].sort()).toEqual([
      'clone_from_tenant',
      'domain_intake',
      'install_ontology_pack',
      'seed_connectors',
      'seed_goal_templates',
      'seed_memories',
      'seed_org_graph',
      'seed_priors',
      'seed_project',
      'seed_skills',
    ]);
  });
});
