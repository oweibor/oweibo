/**
 * D.3 — ComplianceRulePackRegistry tests.
 */
import type { ComplianceRulePack } from '@oweibo/core-contracts';
import { ActionClassExtensionRegistry } from '../ActionClassExtensionRegistry.js';
import {
  ComplianceRulePackRegistry,
  V1_COMPLIANCE_RULE_PACKS,
} from '../ComplianceRulePackRegistry.js';

const minimalPack = (slug: string, rules: ComplianceRulePack['rules'] = []): ComplianceRulePack => ({
  domainSlug: slug,
  packVersion: '1.0.0-stub',
  compliancePostures: [],
  actionClassExtensions: [],
  rules,
  metadata: {
    authoredBy: 'test',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    regulatoryRefs: [],
  },
});

describe('ComplianceRulePackRegistry — defaults', () => {
  it('loads v1 packs for fintech, healthcare, legal', () => {
    const reg = new ComplianceRulePackRegistry();
    const slugs = reg.list().map((p) => p.domainSlug);
    expect(slugs).toEqual(['fintech', 'healthcare', 'legal']);
    expect(V1_COMPLIANCE_RULE_PACKS).toHaveLength(3);
  });

  it('registers action-class extensions with the supplied registry at construction', () => {
    const ext = new ActionClassExtensionRegistry();
    new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
      actionClassExtensionRegistry: ext,
    });
    expect(ext.isRegistered('phi.read')).toBe(true);
    expect(ext.isRegistered('phi.write')).toBe(true);
    expect(ext.isRegistered('phi.transmit_external')).toBe(true);
    expect(ext.isRegistered('pci.cardholder_data_access')).toBe(true);
  });

  it('rejects duplicate packs for the same domain', () => {
    expect(() => new ComplianceRulePackRegistry([minimalPack('x'), minimalPack('x')])).toThrow(
      /duplicate pack/,
    );
  });
});

describe('ComplianceRulePackRegistry — applicableRules', () => {
  it('returns rules from the tenant\'s bound domains filtered by phase', async () => {
    const reg = new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
      tenantDomainLookup: async () => ['healthcare'],
    });
    const rules = await reg.applicableRules('tenant-1', 'action_time');
    expect(rules.length).toBeGreaterThan(0);
    for (const { rule, pack } of rules) {
      expect(rule.enforcementPhase).toBe('action_time');
      expect(pack.domainSlug).toBe('healthcare');
    }
  });

  it('returns [] when tenant has no domains and no defaultDomains', async () => {
    const reg = new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
      tenantDomainLookup: async () => [],
    });
    const rules = await reg.applicableRules('tenant-1', 'action_time');
    expect(rules).toEqual([]);
  });

  it('falls back to defaultDomains when lookup returns []', async () => {
    const reg = new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
      tenantDomainLookup: async () => [],
      defaultDomains: ['fintech'],
    });
    const rules = await reg.applicableRules('tenant-1', 'action_time');
    expect(rules.every(({ pack }) => pack.domainSlug === 'fintech')).toBe(true);
  });

  it('lookup failure degrades to defaultDomains rather than throwing', async () => {
    const reg = new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
      tenantDomainLookup: async () => { throw new Error('db down'); },
      defaultDomains: ['fintech'],
    });
    const rules = await reg.applicableRules('tenant-1', 'action_time');
    expect(rules.length).toBeGreaterThan(0);
  });

  it('returns rules from multiple domains when the tenant is bound to >1 (stacking)', async () => {
    const reg = new ComplianceRulePackRegistry(V1_COMPLIANCE_RULE_PACKS, {
      tenantDomainLookup: async () => ['fintech', 'healthcare'],
    });
    const rules = await reg.applicableRules('tenant-1', 'action_time');
    const domains = new Set(rules.map(({ pack }) => pack.domainSlug));
    expect(domains.has('fintech')).toBe(true);
    expect(domains.has('healthcare')).toBe(true);
  });
});
