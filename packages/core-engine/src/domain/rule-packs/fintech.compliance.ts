/**
 * D.3: fintech compliance rule pack — v1 stub.
 *
 * Adds `pci.cardholder_data_access` to the action-class taxonomy and a
 * handful of PCI-shaped rules covering the most common SMB-fintech
 * failure modes. Full SME-curated pack lands incrementally; the shape
 * is stable.
 */
import type { ComplianceRulePack } from '@oweibo/core-contracts';

export const fintechCompliancePack: ComplianceRulePack = {
  domainSlug: 'fintech',
  packVersion: '1.0.0-stub',
  compliancePostures: ['PCI-DSS', 'SOC2'],
  actionClassExtensions: [
    {
      slug: 'pci.cardholder_data_access',
      description: 'Read cardholder data fields (PAN, expiration, CVV, …)',
      sourceDomain: 'fintech',
      defaultPolicy: {
        young: 'require_approval',
        withSignal: 'require_approval',
        established: 'dry_run',
        alwaysRequireApproval: false,
      },
    },
    {
      slug: 'pci.cardholder_data_modify',
      description: 'Write or delete cardholder data fields',
      sourceDomain: 'fintech',
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
      ruleId: 'fintech-no-pan-in-logs',
      title: 'PAN must not appear in log payloads',
      description:
        'Detects literal 13-19-digit sequences in audit payloads — proxy for unredacted PAN.',
      enforcementPhase: 'action_time',
      appliesToActionClasses: ['*'],
      check: 'deterministic',
      checkConfig: { fn: 'payloadRegexAbsent', pattern: '\\b\\d{13,19}\\b' },
      severity: 'block',
      remediation: 'Tokenize or hash PAN-like fields before audit logging; never log raw PAN.',
      bypassPolicy: 'never',
    },
    {
      ruleId: 'fintech-cardholder-access-requires-purpose',
      title: 'Cardholder-data access requires a stated purpose',
      description:
        'Actions in the pci.cardholder_data_* classes must include a non-empty `purpose` field on the payload.',
      enforcementPhase: 'action_time',
      appliesToActionClasses: ['pci.cardholder_data_access', 'pci.cardholder_data_modify'],
      check: 'deterministic',
      checkConfig: { fn: 'payloadFieldPresent', field: 'purpose', minLength: 10 },
      severity: 'block',
      remediation: 'Add a purpose field (>=10 chars) to the action payload — PCI-DSS 7.1 access justification.',
      bypassPolicy: 'platform_admin_only',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    regulatoryRefs: [
      { framework: 'PCI-DSS', section: '3.4', url: 'https://www.pcisecuritystandards.org/' },
      { framework: 'PCI-DSS', section: '7.1' },
    ],
  },
};
