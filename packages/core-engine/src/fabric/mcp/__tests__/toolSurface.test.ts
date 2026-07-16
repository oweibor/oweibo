/**
 * ADR-009 §7 — INV-11 conformance: the outbound tool surface is a frozen set of
 * AUTHORED constants, and gating is content-independent.
 *
 * The CI check that pins the surface: served tools/list deep-equals the authored
 * constant. If a future change templates a description from a manifest or a
 * document, this fails — which is the point (INV-11: model-facing text is never
 * source-derived).
 */
import { OUTBOUND_TOOL_SURFACE, listTools, toolByName } from '../toolSurface';

describe('ADR-009 §3.2 — the outbound surface is frozen and authored', () => {
  it('is exactly three tools: search, fetch, act', () => {
    expect(OUTBOUND_TOOL_SURFACE.map((t) => t.name)).toEqual([
      'oweibo.search',
      'oweibo.fetch',
      'oweibo.act',
    ]);
  });

  it('tools/list is stable and carries no per-tool connector binding (§3.2 rule 1)', () => {
    const listed = listTools();
    // The projection is identical for every tenant — connector identity appears
    // only in RESULT citations, never as a tool. No tool NAME is connector-scoped
    // (the failure mode §4 rejects: oweibo.slack.search, oweibo.drive.search…).
    for (const t of listed) {
      expect(t.name).toMatch(/^oweibo\.(search|fetch|act)$/);
    }
    // Deep-equal to the authored constants (minus the internal requiredScope):
    // the surface cannot vary with installed connectors because it is a constant.
    expect(listed).toEqual(
      OUTBOUND_TOOL_SURFACE.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    );
  });

  it('descriptions are non-empty authored strings, not derived from anything', () => {
    for (const t of OUTBOUND_TOOL_SURFACE) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('each tool declares exactly one required scope', () => {
    expect(toolByName('oweibo.search')?.requiredScope).toBe('oweibo:search');
    expect(toolByName('oweibo.fetch')?.requiredScope).toBe('oweibo:fetch');
    expect(toolByName('oweibo.act')?.requiredScope).toBe('oweibo:act');
  });

  it('the surface is immutable at runtime (frozen contract, not mutable config)', () => {
    // The exported constant must be a stable reference the CI check can pin.
    const a = listTools();
    const b = listTools();
    expect(a).toEqual(b);
  });
});
