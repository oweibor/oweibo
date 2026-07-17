/**
 * Custom connector manifest validation — the pure contract.
 *
 * The rules a tenant-authored manifest must satisfy, and — more importantly —
 * the claims it must be PREVENTED from making (INV-15: declare only what
 * certification can demonstrate; INV-11: every action needs a gateable class).
 */
import {
  CUSTOM_CONNECTOR_ID_PATTERN,
  validateCustomManifest,
  type CustomConnectorManifestInput,
} from '../customManifest.js';

const valid = (over: Partial<CustomConnectorManifestInput> = {}): CustomConnectorManifestInput => ({
  connectorId: 'custom.acme-tracker',
  displayName: 'Acme Tracker',
  category: 'custom',
  description: 'Internal issue tracker at Acme.',
  catalogVersion: '1.0.0',
  credentialSchema: { type: 'object', required: ['api_key'], properties: { api_key: { type: 'string' } } },
  ...over,
});

describe('custom manifest — identity and shape', () => {
  it('accepts a minimal valid manifest', () => {
    expect(validateCustomManifest(valid())).toEqual([]);
  });

  it("requires the 'custom.' id prefix — a tenant manifest can never shadow a platform catalog id", () => {
    for (const id of ['acme-tracker', 'google-drive', 'slack', 'custom.', 'custom.UPPER', 'Custom.x']) {
      const v = validateCustomManifest(valid({ connectorId: id }));
      expect(v.some((x) => x.field === 'connectorId')).toBe(true);
    }
    expect(CUSTOM_CONNECTOR_ID_PATTERN.test('custom.acme_tracker-2')).toBe(true);
  });

  it('category must come from the closed ConnectorCategory set', () => {
    const v = validateCustomManifest(valid({ category: 'messaging' }));
    expect(v.some((x) => x.field === 'category')).toBe(true);
    expect(validateCustomManifest(valid({ category: 'source_control' }))).toEqual([]);
  });

  it('credentialSchema must be a JSON Schema object (the UI renders the credential form from it)', () => {
    for (const bad of [null, 'string', 42, [], {}]) {
      const v = validateCustomManifest(valid({ credentialSchema: bad }));
      expect(v.some((x) => x.field === 'credentialSchema')).toBe(true);
    }
  });
});

describe('custom manifest — capability governance', () => {
  it('every capability MUST carry an action class — an action without a class cannot be gated (INV-11)', () => {
    const v = validateCustomManifest(valid({
      capabilities: [{ capabilityId: 'create_ticket', summary: 'Create a ticket', actionClass: '' }],
    }));
    expect(v.some((x) => x.field === 'capabilities[0].actionClass')).toBe(true);
  });

  it('reserved governance.* classes are NOT declarable — the platform control plane is not a tenant surface', () => {
    const v = validateCustomManifest(valid({
      capabilities: [{
        capabilityId: 'sneaky', summary: 'x',
        actionClass: 'governance.policy_relaxation',
      }],
    }));
    expect(v.some((x) => x.field === 'capabilities[0].actionClass' && /control plane/.test(x.message))).toBe(true);
  });

  it('ordinary action classes pass (the trust ladder gates them like any action)', () => {
    const v = validateCustomManifest(valid({
      capabilities: [
        { capabilityId: 'create_ticket', summary: 'Create a ticket', actionClass: 'write.external_api.nonprod' },
        { capabilityId: 'read_ticket', summary: 'Read a ticket', actionClass: 'read.external_api' },
      ],
    }));
    expect(v).toEqual([]);
  });

  it('duplicate capability ids are refused', () => {
    const v = validateCustomManifest(valid({
      capabilities: [
        { capabilityId: 'a', summary: 'x', actionClass: 'read.external_api' },
        { capabilityId: 'a', summary: 'y', actionClass: 'read.external_api' },
      ],
    }));
    expect(v.some((x) => /duplicate/.test(x.message))).toBe(true);
  });
});

describe('custom manifest — MCP declaration pairing (ADR-009 §3.6)', () => {
  it('an MCP server with declared tools is valid — the declared set becomes the inbound authority', () => {
    const v = validateCustomManifest(valid({
      mcpServerUrl: 'https://mcp.acme.internal/tracker',
      declaredTools: ['tracker.search', 'tracker.create'],
    }));
    expect(v).toEqual([]);
  });

  it('an MCP server WITHOUT declared tools is refused — the manifest is the authority set, not the server', () => {
    const v = validateCustomManifest(valid({ mcpServerUrl: 'https://mcp.acme.internal/tracker' }));
    expect(v.some((x) => x.field === 'declaredTools')).toBe(true);
  });

  it('declared tools WITHOUT an MCP server are refused', () => {
    const v = validateCustomManifest(valid({ declaredTools: ['tracker.search'] }));
    expect(v.some((x) => x.field === 'declaredTools')).toBe(true);
  });

  it('rejects non-http(s) MCP URLs and duplicate tool names', () => {
    expect(validateCustomManifest(valid({
      mcpServerUrl: 'ftp://mcp.acme.internal', declaredTools: ['t'],
    })).some((x) => x.field === 'mcpServerUrl')).toBe(true);

    expect(validateCustomManifest(valid({
      mcpServerUrl: 'https://mcp.acme.internal', declaredTools: ['t', 't'],
    })).some((x) => /duplicate tool/.test(x.message))).toBe(true);
  });
});
