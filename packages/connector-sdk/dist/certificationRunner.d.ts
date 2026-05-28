/**
 * D.4: certification runner — exercises a `ConnectorBundle` against the
 * tier-appropriate battery.
 *
 *   - experimental: schema validation only
 *   - community:    + every capability has sandbox declaration that
 *                     completes a round-trip invocation
 *                   + declared inspectors / verifiers load without error
 *   - verified:     + rollback round-trip (when declared)
 *                   + at least one platform-team review (asserted by the
 *                     caller via the `platformReviewers` input)
 *   - enterprise:   + every domain in `certifiedFor` passes its battery
 *                   + named maintainer (caller supplies)
 *
 * The runner is intentionally synchronous in its decision-making —
 * collect every failure, then mark `passed = false`. CI logs the full
 * report so reviewers see the complete picture instead of fixing
 * issues one PR at a time.
 *
 * Per-domain battery seam: callers supply a `batteries` map; the
 * runner picks the battery for each domain in `spec.certifiedFor`. A
 * missing battery for a declared domain is a hard failure at the
 * enterprise tier and a warning otherwise.
 */
import type { ConnectorBundle } from './declareConnector.js';
import { type ValidationViolation } from './contractValidator.js';
import type { DomainCertificationBattery } from './domainBattery.js';
export type CertificationTier = 'experimental' | 'community' | 'verified' | 'enterprise';
export interface CertificationStepReport {
    readonly step: string;
    readonly passed: boolean;
    readonly violations: readonly string[];
}
export interface CertificationReport {
    readonly bundle: {
        connectorId: string;
        catalogVersion: string;
    };
    readonly tier: CertificationTier;
    readonly passed: boolean;
    readonly steps: readonly CertificationStepReport[];
    readonly violations: readonly ValidationViolation[];
    /** Stable hash over the steps; persisted to connector_certifications.test_suite_hash. */
    readonly testSuiteHash: string;
}
export interface CertificationRunInput {
    readonly bundle: ConnectorBundle;
    readonly tier: CertificationTier;
    readonly batteries?: Readonly<Record<string, DomainCertificationBattery>>;
    /** Verified+ tier requires at least one entry. */
    readonly platformReviewers?: readonly string[];
    /** Enterprise tier requires a named maintainer. */
    readonly maintainer?: {
        readonly name: string;
        readonly slaMinutes: number;
    };
    /** Fixtures the battery's `run()` calls consult. */
    readonly fixtures?: Readonly<Record<string, unknown>>;
    /**
     * Optional override for the sandbox invoker. Tests can supply a
     * deterministic stub; production wires the real sandbox runtime.
     */
    readonly sandboxInvoker?: (input: {
        capabilityId: string;
        invokeInput: unknown;
        bundle: ConnectorBundle;
    }) => Promise<{
        output: unknown;
        auditRow?: Record<string, unknown>;
    }>;
}
export declare function runCertificationSuite(input: CertificationRunInput): Promise<CertificationReport>;
//# sourceMappingURL=certificationRunner.d.ts.map