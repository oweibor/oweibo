/**
 * D.2: healthcare rubrics — v1 stubs.
 */
import type { DomainRubric } from '@oweibo/core-contracts';

export const healthcarePhiRedactionRubric: DomainRubric = {
  domainSlug: 'healthcare',
  rubricId: 'phi-redaction',
  title: 'PHI redaction in logs and audit details',
  description: 'PHI fields (SSN, DOB, MRN, diagnosis codes) are stripped or hashed before logging.',
  appliesToTaskKinds: ['code_change'],
  weight: 0.4,
  version: '1.0',
  criteria: [
    {
      criterionId: 'no-plaintext-ssn',
      description: 'No literal SSN-shaped string (NNN-NN-NNNN) in code',
      check: 'deterministic',
      checkConfig: { fn: 'grepAbsent', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
      weight: 0.5,
      failureBlocks: true,
    },
    {
      criterionId: 'no-plaintext-mrn-in-logs',
      description: 'Log calls do not include bare MRN fields',
      check: 'deterministic',
      checkConfig: { fn: 'grepAbsent', pattern: '(console\\.log|logger\\.\\w+)\\([^)]*mrn' },
      weight: 0.5,
      failureBlocks: true,
    },
  ],
};

export const healthcareMinimumNecessaryRubric: DomainRubric = {
  domainSlug: 'healthcare',
  rubricId: 'hipaa-minimum-necessary',
  title: 'Minimum necessary use of PHI',
  description: 'PHI queries select only fields required for the stated purpose.',
  appliesToTaskKinds: ['code_change'],
  weight: 0.3,
  version: '1.0',
  criteria: [
    {
      criterionId: 'no-select-star-on-patient',
      description: 'No SELECT * against patient or PHI-bearing tables',
      check: 'deterministic',
      checkConfig: { fn: 'grepAbsent', pattern: 'SELECT\\s+\\*\\s+FROM\\s+(patient|encounter|phi_)' },
      weight: 1.0,
      failureBlocks: false,
    },
  ],
};
