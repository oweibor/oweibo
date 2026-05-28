/**
 * D.4: shape validation for a `ConnectorBundle`. Run at certification
 * time (and ideally also in the connector author's own unit tests) to
 * catch the most common mistakes:
 *
 *   - missing required fields on the catalog entry
 *   - capabilityId / inputSchema / outputSchema shape problems
 *   - inconsistencies between the spec and the derived catalog entry
 *
 * Returns a `ValidationReport` rather than throwing so the
 * certificationRunner can collect every violation at once instead of
 * surfacing them one at a time.
 */
import type { ConnectorBundle } from './declareConnector.js';
export interface ValidationViolation {
    readonly path: string;
    readonly message: string;
}
export interface ValidationReport {
    readonly ok: boolean;
    readonly violations: readonly ValidationViolation[];
}
export declare function validateBundle(bundle: ConnectorBundle): ValidationReport;
//# sourceMappingURL=contractValidator.d.ts.map