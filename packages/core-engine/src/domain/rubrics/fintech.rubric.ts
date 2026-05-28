/**
 * D.2: fintech rubrics — v1 stubs.
 *
 * Initial rubric set covers the highest-yield checks for SMB financial
 * services tenants: audit trail (regulatory necessity), idempotency
 * (settlement correctness), decimal precision (monetary handling),
 * currency handling, and regulatory disclosure. Each rubric ships with
 * ~2-4 criteria as v1 seeds; SMEs expand per the rubric library table
 * in ttv-domain-depth.md §D.2.
 */
import type { DomainRubric } from '@oweibo/core-contracts';

export const fintechAuditTrailRubric: DomainRubric = {
  domainSlug: 'fintech',
  rubricId: 'audit-trail-completeness',
  title: 'Audit trail completeness',
  description:
    'Every state-mutating action records who, what, when, and why; mutation reasons exceed 20 chars.',
  appliesToTaskKinds: ['code_change', 'database_migration', 'workflow_change'],
  weight: 0.4,
  version: '1.0',
  criteria: [
    {
      criterionId: 'has-actor-attribution',
      description: 'Mutation includes actor user_id or principal',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: 'actor_(user_id|principal)', scope: 'modified_lines' },
      weight: 0.3,
      failureBlocks: false,
    },
    {
      criterionId: 'has-mutation-reason',
      description: 'Mutation includes a reason of >20 chars',
      check: 'deterministic',
      checkConfig: { fn: 'auditFieldPresent', field: 'reason', minLength: 20 },
      weight: 0.3,
      failureBlocks: true,
    },
    {
      criterionId: 'has-timestamp',
      description: 'Mutation records an occurred_at timestamp',
      check: 'deterministic',
      checkConfig: { fn: 'auditFieldPresent', field: 'occurred_at' },
      weight: 0.2,
      failureBlocks: true,
    },
    {
      criterionId: 'has-before-state',
      description: 'For UPDATEs, records before-state hash',
      check: 'deterministic',
      checkConfig: { fn: 'auditFieldPresent', field: 'before_hash' },
      weight: 0.2,
      failureBlocks: false,
    },
  ],
};

export const fintechIdempotencyRubric: DomainRubric = {
  domainSlug: 'fintech',
  rubricId: 'transaction-idempotency',
  title: 'Transaction idempotency',
  description:
    'Money-moving operations expose an idempotency-key surface so duplicate submissions are detected.',
  appliesToTaskKinds: ['code_change'],
  weight: 0.3,
  version: '1.0',
  criteria: [
    {
      criterionId: 'idempotency-key-accepted',
      description: 'Handler accepts an Idempotency-Key header or argument',
      check: 'deterministic',
      checkConfig: { fn: 'grepCheck', pattern: '(idempotency[_-]?key|Idempotency-Key)' },
      weight: 1.0,
      failureBlocks: false,
    },
  ],
};

export const fintechDecimalPrecisionRubric: DomainRubric = {
  domainSlug: 'fintech',
  rubricId: 'decimal-precision',
  title: 'Decimal precision for money',
  description: 'Monetary fields use a decimal type (DECIMAL/NUMERIC), not floating-point.',
  appliesToTaskKinds: ['code_change', 'database_migration'],
  weight: 0.3,
  version: '1.0',
  criteria: [
    {
      criterionId: 'no-float-for-money',
      description: 'Modified lines do not assign FLOAT/REAL to a monetary column',
      check: 'deterministic',
      checkConfig: { fn: 'grepAbsent', pattern: '(amount|price|balance)\\s+(FLOAT|REAL|DOUBLE)' },
      weight: 1.0,
      failureBlocks: true,
    },
  ],
};
