/**
 * D.4 — contractValidator tests.
 */
import { declareConnector } from '../declareConnector.js';
import { validateBundle } from '../contractValidator.js';

const baseSpec = {
  connectorId: 'demo',
  displayName: 'Demo',
  category: 'custom' as const,
  description: 'demo',
  catalogVersion: '1.0.0',
  credentialSchema: { type: 'object' },
  capabilities: [
    {
      capabilityId: 'do-thing',
      summary: 'Do a thing',
      actionClass: 'write.local.scratch',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      invoke: async () => ({ status: 'ok' as const }),
      sandbox: { mode: 'mock' as const },
    },
  ],
  certificationTarget: 'community' as const,
};

describe('validateBundle', () => {
  it('passes a clean bundle', () => {
    const r = validateBundle(declareConnector(baseSpec));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('flags non-kebab connectorId', () => {
    const b = declareConnector({ ...baseSpec, connectorId: 'badId-' });
    // declareConnector itself does not validate this — only the contract
    // validator does, so the bundle constructs cleanly first.
    const r = validateBundle(b);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.path.includes('connectorId'))).toBe(true);
  });

  it('flags empty displayName', () => {
    const b = declareConnector({ ...baseSpec, displayName: '' });
    const r = validateBundle(b);
    expect(r.violations.some((v) => v.path === 'spec.displayName')).toBe(true);
  });

  it('flags a non-JSONSchema credentialSchema', () => {
    const b = declareConnector({ ...baseSpec, credentialSchema: 'oops' as never });
    const r = validateBundle(b);
    expect(r.violations.some((v) => v.path === 'spec.credentialSchema')).toBe(true);
  });
});
