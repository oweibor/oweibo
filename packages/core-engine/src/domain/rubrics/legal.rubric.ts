/**
 * D.2: legal rubrics — v1 stubs.
 */
import type { DomainRubric } from '@oweibo/core-contracts';

export const legalCitationAccuracyRubric: DomainRubric = {
  domainSlug: 'legal',
  rubricId: 'citation-accuracy',
  title: 'Citation accuracy',
  description: 'Legal references use canonical citation format and link to authoritative sources.',
  appliesToTaskKinds: ['document_draft'],
  weight: 0.4,
  version: '1.0',
  criteria: [
    {
      criterionId: 'citation-format-present',
      description: 'Document includes at least one canonical citation (e.g. NNN U.S. NNN)',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: '\\b\\d{1,3}\\s+U\\.S\\.\\s+\\d+\\b' },
      weight: 1.0,
      failureBlocks: false,
    },
  ],
};

export const legalPrivilegePreservationRubric: DomainRubric = {
  domainSlug: 'legal',
  rubricId: 'privilege-preservation',
  title: 'Attorney-client privilege preservation',
  description: 'Documents flagged as privileged are marked accordingly and not commingled with non-privileged output.',
  appliesToTaskKinds: ['document_draft'],
  weight: 0.3,
  version: '1.0',
  criteria: [
    {
      criterionId: 'privileged-marker-present',
      description: 'Privileged documents carry the canonical header',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: '(ATTORNEY-CLIENT PRIVILEGED|PRIVILEGED AND CONFIDENTIAL)' },
      weight: 1.0,
      failureBlocks: true,
    },
  ],
};
