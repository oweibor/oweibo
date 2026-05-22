"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.STARTER_TEMPLATE_SLUGS = void 0;
exports.starterProjectSpec = starterProjectSpec;
const BASELINE_INVARIANTS = {
    'project.style': 'starter',
};
const DEFAULT_NAME = 'Default';
const DEFAULT_DESCRIPTION = 'Starter project — rename or archive as needed.';
const DEFAULT_TAGS = ['scope:starter', 'seed:starter-project'];
const TEMPLATE_INVARIANTS = {
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
function starterProjectSpec(templateSlug) {
    const invariants = TEMPLATE_INVARIANTS[templateSlug] ?? BASELINE_INVARIANTS;
    return {
        name: DEFAULT_NAME,
        description: DEFAULT_DESCRIPTION,
        invariants,
        tags: DEFAULT_TAGS,
    };
}
/** Read-only list of template slugs the starter registry knows about. */
exports.STARTER_TEMPLATE_SLUGS = Object.keys(TEMPLATE_INVARIANTS);
//# sourceMappingURL=StarterProjectTemplates.js.map