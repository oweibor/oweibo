/**
 * T.2.b: per-template invariants for the starter project SeedProjectStep
 * installs. These map the tenant_bootstrap.template_slug to a small set of
 * key→value facts the agent gets to start with. Templates that aren't in
 * the registry fall back to BASELINE_INVARIANTS.
 *
 * The full template catalog ships in T.6; this file is the minimal bridge
 * so day-one onboarding has *some* invariants to point at. Adding a new
 * template here is a one-line change.
 */

export interface StarterProjectSpec {
  readonly name: string;
  readonly description: string;
  readonly invariants: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

const BASELINE_INVARIANTS: Readonly<Record<string, string>> = {
  'project.style': 'starter',
};

const DEFAULT_NAME = 'Default';
const DEFAULT_DESCRIPTION = 'Starter project — rename or archive as needed.';
const DEFAULT_TAGS: readonly string[] = ['scope:starter', 'seed:starter-project'];

const TEMPLATE_INVARIANTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  default: BASELINE_INVARIANTS,
  'typescript-app': {
    ...BASELINE_INVARIANTS,
    language: 'typescript',
    'test-runner': 'vitest',
  },
  'python-app': {
    ...BASELINE_INVARIANTS,
    language: 'python',
    'test-runner': 'pytest',
  },
  'nextjs-app': {
    ...BASELINE_INVARIANTS,
    language: 'typescript',
    framework: 'nextjs',
    'test-runner': 'vitest',
  },
};

export function starterProjectSpec(templateSlug: string): StarterProjectSpec {
  const invariants = TEMPLATE_INVARIANTS[templateSlug] ?? BASELINE_INVARIANTS;
  return {
    name: DEFAULT_NAME,
    description: DEFAULT_DESCRIPTION,
    invariants,
    tags: DEFAULT_TAGS,
  };
}

/** Read-only list of template slugs the starter registry knows about. */
export const STARTER_TEMPLATE_SLUGS: readonly string[] = Object.keys(TEMPLATE_INVARIANTS);
