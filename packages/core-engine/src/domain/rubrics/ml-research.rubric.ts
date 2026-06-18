/**
 * D.2: ml-research rubrics — v1 stubs.
 */
import type { DomainRubric } from '@oweibo/core-contracts';

export const mlResearchReproducibilityRubric: DomainRubric = {
  domainSlug: 'ml-research',
  rubricId: 'reproducibility',
  title: 'Experiment reproducibility',
  description: 'Training scripts fix random seeds and pin dependency versions.',
  appliesToTaskKinds: ['code_change', 'experiment_run'],
  weight: 0.4,
  version: '1.0',
  criteria: [
    {
      criterionId: 'seeds-pinned',
      description: 'Code sets a torch/numpy/random seed',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: '(torch\\.manual_seed|np\\.random\\.seed|random\\.seed)' },
      weight: 0.5,
      failureBlocks: false,
    },
    {
      criterionId: 'deps-pinned',
      description: 'requirements.txt / pyproject pin exact versions',
      check: 'deterministic',
      checkConfig: { fn: 'grepAbsent', pattern: '^\\s*[a-zA-Z][\\w-]*\\s*$' },
      weight: 0.5,
      failureBlocks: false,
    },
  ],
};

export const mlResearchDatasetProvenanceRubric: DomainRubric = {
  domainSlug: 'ml-research',
  rubricId: 'dataset-provenance',
  title: 'Dataset provenance recorded',
  description: 'Training jobs record dataset source, version, and hash.',
  appliesToTaskKinds: ['experiment_run'],
  weight: 0.3,
  version: '1.0',
  criteria: [
    {
      criterionId: 'dataset-version-recorded',
      description: 'Code references a dataset_version or dataset_hash variable',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: 'dataset_(version|hash|id|sha)' },
      weight: 1.0,
      failureBlocks: false,
    },
  ],
};
