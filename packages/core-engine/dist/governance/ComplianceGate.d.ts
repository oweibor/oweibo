/**
 * ComplianceGate — deterministic fintech/payment security compliance gate (§16e).
 *
 * Runs a deterministic checklist against generated ArtifactBundles before they
 * are committed to the workspace. Blocks bundles that violate critical security
 * invariants and emits structured violation reports to the audit trail.
 *
 * Designed for fintech/payment use-cases (OWASP ASVS L2, PCI-DSS v4, GDPR).
 */
import type { ArtifactBundle } from '@oweibo/core-contracts';
export type ComplianceSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface ComplianceViolation {
    readonly ruleId: string;
    readonly severity: ComplianceSeverity;
    readonly message: string;
    readonly filePath?: string;
    readonly evidence?: string;
}
export interface ComplianceGateResult {
    readonly passed: boolean;
    readonly violations: readonly ComplianceViolation[];
    readonly warnings: readonly ComplianceViolation[];
    readonly checkedAt: string;
    readonly summary: {
        critical: number;
        high: number;
        medium: number;
        low: number;
    };
}
export interface ComplianceGateOptions {
    /** Block on 'critical' only, or also on 'high'. Default: 'critical'. */
    readonly blockOn?: 'critical' | 'high';
    /** Skip specific rule IDs (e.g. rules not applicable to this app). */
    readonly skipRules?: ReadonlySet<string>;
}
export declare class ComplianceGate {
    private readonly blockOn;
    private readonly skipRules;
    constructor(options?: ComplianceGateOptions);
    /**
     * Run all compliance rules against an ArtifactBundle.
     * Returns a ComplianceGateResult indicating pass/fail and all violations.
     */
    check(bundle: ArtifactBundle): ComplianceGateResult;
    /**
     * Assert that the bundle passes all compliance gates.
     * Throws a ComplianceViolationError if any blocking violations are found.
     */
    assert(bundle: ArtifactBundle): void;
}
export declare class ComplianceViolationError extends Error {
    readonly result: ComplianceGateResult;
    constructor(result: ComplianceGateResult);
}
//# sourceMappingURL=ComplianceGate.d.ts.map