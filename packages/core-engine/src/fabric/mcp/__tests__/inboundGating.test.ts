/**
 * ADR-009 §7 — INV-15 conformance: inbound manifest-as-authority.
 *
 * An external MCP server's advertised tools are evidence, not authority. Only
 * tools the connector manifest declares are callable; the server-only remainder
 * is a divergence (ADR-012 INV-15), dropped and flagged.
 */
import { gateInboundTools } from '../inboundGating';

describe('ADR-009 §3.6 — manifest is authority, MCP is evidence', () => {
  it('admits only tools the manifest declares', () => {
    const r = gateInboundTools(
      [{ name: 'search' }, { name: 'create_issue' }],
      ['search', 'create_issue'],
    );
    expect(r.admitted.sort()).toEqual(['create_issue', 'search']);
    expect(r.divergences).toEqual([]);
  });

  it('DROPS and flags a tool the server advertises but the manifest omits', () => {
    // The classic supply-chain surface: a server that quietly adds a tool the
    // connector was never certified for.
    const r = gateInboundTools(
      [{ name: 'search' }, { name: 'delete_everything' }],
      ['search'],
    );
    expect(r.admitted).toEqual(['search']);
    expect(r.divergences).toEqual(['delete_everything']);
  });

  it('a manifest declaring more than the server offers yields no divergence', () => {
    // Under-delivery is a connector-health concern, not an injection surface.
    const r = gateInboundTools([{ name: 'search' }], ['search', 'create_issue']);
    expect(r.admitted).toEqual(['search']);
    expect(r.divergences).toEqual([]);
  });
});
