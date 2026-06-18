/**
 * D.3: legal compliance rule pack — v1 minimal stub.
 *
 * Privilege preservation is the highest-yield concern: outbound legal
 * communications that include a `privileged: true` flag must not be
 * routed to non-attorney recipients without explicit waiver.
 */
import type { ComplianceRulePack } from '@oweibo/core-contracts';

export const legalCompliancePack: ComplianceRulePack = {
  domainSlug: 'legal',
  packVersion: '1.0.0-stub',
  compliancePostures: ['SOC2'],
  actionClassExtensions: [],
  rules: [
    {
      ruleId: 'legal-privileged-no-external-route',
      title: 'Privileged communications must not route externally without waiver',
      description:
        'comm.external_* actions whose payload is flagged privileged require an explicit `waiverId`.',
      enforcementPhase: 'action_time',
      appliesToActionClasses: ['comm.external_email', 'comm.external_message'],
      check: 'deterministic',
      checkConfig: {
        fn: 'payloadCondition',
        condition: 'privileged_implies_waiver',
      },
      severity: 'block',
      remediation:
        'Either remove the privileged flag (if not actually privileged) or attach a waiverId referencing the privilege waiver document.',
      bypassPolicy: 'tenant_admin',
    },
  ],
  metadata: {
    authoredBy: 'platform-domain-team@oweibo (2026-05-28)',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    regulatoryRefs: [{ framework: 'ABA Model Rule 1.6', section: 'Confidentiality of Information' }],
  },
};
