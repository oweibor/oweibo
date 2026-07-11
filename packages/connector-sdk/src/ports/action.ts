/**
 * K.1 — ActionPort: the live-tool face (Claude connectors).
 *
 * This port has NO new interface: the shipped `capabilities[]` model
 * (declareConnector — `invoke`, `actionClass`, `sandbox`, `inspectors`,
 * `verifiers`, `rollback`) IS the Action port (ADR-012 §3.2, Appendix A
 * entry 2). It is mapped, not redefined: `supports.actions` is
 * demonstrated by the capabilities passing their existing certification
 * steps (sandbox round-trip etc.), and failures map onto the trust
 * ladder / action-safety machinery rather than the §11.7 taxonomy.
 *
 * The alias below exists so `PortBindings` can name all six faces
 * uniformly in documentation; authors keep writing `capabilities[]`.
 */
import type { CapabilityDeclaration } from '../declareConnector.js';

/** The Action port = the connector's capability list. */
export type ActionPort = readonly CapabilityDeclaration[];
