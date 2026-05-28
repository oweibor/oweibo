/**
 * D.2: devops rubrics — v1 stubs.
 */
import type { DomainRubric } from '@oweibo/core-contracts';

export const devopsRollbackStrategyRubric: DomainRubric = {
  domainSlug: 'devops',
  rubricId: 'rollback-strategy-present',
  title: 'Rollback strategy is declared',
  description: 'Database migrations and deployments include rollback steps or note that rollback is N/A.',
  appliesToTaskKinds: ['database_migration', 'deploy_config_change'],
  weight: 0.4,
  version: '1.0',
  criteria: [
    {
      criterionId: 'rollback-mentioned',
      description: 'Artifact body or PR notes mention rollback',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: '(rollback|revert plan|ROLLBACK)' },
      weight: 1.0,
      failureBlocks: false,
    },
  ],
};

export const devopsObservabilityRubric: DomainRubric = {
  domainSlug: 'devops',
  rubricId: 'observability-completeness',
  title: 'New code paths emit observability signal',
  description: 'New request handlers and background jobs emit at least one log or metric.',
  appliesToTaskKinds: ['code_change'],
  weight: 0.3,
  version: '1.0',
  criteria: [
    {
      criterionId: 'log-or-metric-present',
      description: 'Modified code includes a logger or metric call',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: '(logger\\.\\w+|metrics?\\.\\w+|datadog\\.)' },
      weight: 1.0,
      failureBlocks: false,
    },
  ],
};
