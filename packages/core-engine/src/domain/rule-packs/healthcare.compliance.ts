/**
 * D.3: healthcare compliance rule pack — v1 stub.
 *
 * Adds the `phi.*` action classes and the three highest-yield HIPAA
 * rules: PHI-in-logs, minimum-necessary, BAA-required-for-external-
 * transmit.
 */
import type { ComplianceRulePack } from '@oweibo/core-contracts';

export const healthcareCompliancePack: ComplianceRulePack = {
  domainSlug: 'healthcare',
  packVersion: '1.0.0-stub',
  compliancePostures: ['HIPAA'],
  actionClassExtensions: [
    {
      slug: 'phi.read',
      description: 'Read protected health information from any source',
      sourceDomain: 'healthcare',
      defaultPolicy: {
        young: 'require_approval',
        withSignal: 'dry_run',
        established: 'execute',
      },
    },
    {
      slug: 'phi.write',
      description: 'Create or modify PHI',
      sourceDomain: 'healthcare',
      defaultPolicy: {
        young: 'require_approval',
        withSignal: 'require_approval',
        established: 'dry_run',
      },
    },
    {
      slug: 'phi.transmit_external',
      description: 'Transmit PHI beyond the tenant trust boundary',
      sourceDomain: 'healthcare',
      defaultPolicy: {
        young: 'require_approval',
        withSignal: 'require_approval',
        established: 'require_approval',
        alwaysRequireApproval: true,
      },
    },
  ],
  rules: [
    {
      ruleId: 'phi-no-plaintext-logging',
      title: 'PHI identifiers must not appear in plaintext audit details',
      description:
        'Audit payloads on phi.* actions must not contain literal SSN/DOB-shaped strings.',
      enforcementPhase: 'action_time',
      appliesToActionClasses: ['phi.read', 'phi.write', 'phi.transmit_external'],
      check: 'deterministic',
      checkConfig: {
        fn: 'payloadRegexAbsent',
        // SSN NNN-NN-NNNN OR DOB YYYY-MM-DD.
        pattern: '(\\b\\d{3}-\\d{2}-\\d{4}\\b)|(\\b\\d{4}-\\d{2}-\\d{2}\\b)',
      },
      severity: 'block',
      remediation: 'Strip or hash PHI identifiers before audit; reference via opaque id only.',
      bypassPolicy: 'never',
    },
    {
      ruleId: 'phi-external-transmit-requires-baa',
      title: 'External PHI transmission requires a BAA-verified recipient',
      description:
        'phi.transmit_external payloads must include a `baaRecipientId` referencing a verified BAA partner.',
      enforcementPhase: 'action_time',
      appliesToActionClasses: ['phi.transmit_external'],
      check: 'deterministic',
      checkConfig: { fn: 'payloadFieldPresent', field: 'baaRecipientId', minLength: 1 },
      severity: 'block',
      remediation: 'Add recipient to the tenant BAA list, then attach baaRecipientId to the action payload.',
      bypassPolicy: 'platform_admin_only',
    },
    {
      ruleId: 'phi-minimum-necessary-fields',
      title: 'PHI reads should declare fields_requested',
      description:
        'phi.read actions should include a fields_requested list so reviewers can audit minimum-necessary use.',
      enforcementPhase: 'action_time',
      appliesToActionClasses: ['phi.read'],
      check: 'deterministic',
      checkConfig: { fn: 'payloadFieldPresent', field: 'fields_requested' },
      severity: 'warn',
      remediation: 'Add a fields_requested array enumerating the PHI fields actually consumed by this action.',
      bypassPolicy: 'tenant_admin',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    regulatoryRefs: [
      { framework: 'HIPAA', section: '45 CFR 164.312' },
      { framework: 'HIPAA', section: '45 CFR 164.502(b) (Minimum Necessary)' },
    ],
  },
};
