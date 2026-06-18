/**
 * D.4 — declareConnector tests.
 */
import { declareConnector } from '../declareConnector.js';

const VALID_SPEC = {
  connectorId: 'slack',
  displayName: 'Slack',
  category: 'communication' as const,
  description: 'Slack workspace integration',
  catalogVersion: '1.0.0',
  credentialSchema: { type: 'object', properties: { token: { type: 'string' } } },
  capabilities: [
    {
      capabilityId: 'send-message',
      summary: 'Send a message to a channel',
      actionClass: 'comm.external_message',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      invoke: async () => ({ status: 'ok' as const }),
      sandbox: { mode: 'mock' as const },
    },
  ],
  certificationTarget: 'community' as const,
  recommendedFor: ['devops'],
  certifiedFor: ['devops'],
};

describe('declareConnector', () => {
  it('builds a catalog entry that mirrors the spec', () => {
    const b = declareConnector(VALID_SPEC);
    expect(b.catalogEntry.connectorId).toBe('slack');
    expect(b.catalogEntry.capabilities).toHaveLength(1);
    expect(b.catalogEntry.certification).toBe('community');
    expect(b.catalogEntry.certifiedFor).toEqual(['devops']);
    expect(b.catalogEntry.recommendedFor).toEqual(['devops']);
  });

  it('lifts a sandbox declaration into shadowTarget', () => {
    const b = declareConnector(VALID_SPEC);
    expect(b.catalogEntry.capabilities[0]!.shadowTarget?.mode).toBe('mock');
  });

  it('rejects duplicate capabilityIds', () => {
    const dup = {
      ...VALID_SPEC,
      capabilities: [VALID_SPEC.capabilities[0]!, VALID_SPEC.capabilities[0]!],
    };
    expect(() => declareConnector(dup)).toThrow(/duplicate capabilityId/);
  });

  it('rejects empty actionClass', () => {
    const bad = {
      ...VALID_SPEC,
      capabilities: [{ ...VALID_SPEC.capabilities[0]!, actionClass: '' }],
    };
    expect(() => declareConnector(bad)).toThrow(/missing actionClass/);
  });

  it('rejects community+ tier without a sandbox declaration', () => {
    const bad = {
      ...VALID_SPEC,
      capabilities: [{ ...VALID_SPEC.capabilities[0]!, sandbox: undefined }],
    };
    expect(() => declareConnector(bad)).toThrow(/requires capability .* to declare a sandbox/);
  });

  it("permits experimental tier without a sandbox", () => {
    const ok = {
      ...VALID_SPEC,
      certificationTarget: 'experimental' as const,
      capabilities: [{ ...VALID_SPEC.capabilities[0]!, sandbox: undefined }],
    };
    expect(() => declareConnector(ok)).not.toThrow();
  });
});
