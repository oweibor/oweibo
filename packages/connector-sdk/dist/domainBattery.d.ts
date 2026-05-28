/**
 * D.4: per-domain certification battery. A battery is a small bundle
 * of assertions that a connector must pass in order to claim
 * certification for that domain.
 *
 * Each domain SME team owns a battery. The certification runner picks
 * the battery for every slug in `spec.certifiedFor` and runs it
 * against the bundle + a harness that exposes invocation fixtures.
 *
 * Batteries live OUTSIDE the SDK package — they are domain content,
 * not platform machinery — but the contract is defined here so SMEs
 * have a stable seam to author against.
 */
import type { ConnectorBundle, CapabilityDeclaration } from './declareConnector.js';
export interface CertificationHarness {
    /**
     * Run a capability with the given input in its sandbox mode.
     * Returns the capability output for the battery to inspect.
     */
    invokeSandboxed(capabilityId: string, input: unknown): Promise<{
        output: unknown;
        auditRow?: Record<string, unknown>;
    }>;
    /** Find a capability by id; throws when unknown. */
    capability(capabilityId: string): CapabilityDeclaration;
    /** Get the bundle under test. */
    readonly bundle: ConnectorBundle;
    /**
     * Battery-supplied fixtures that the harness wires in (e.g., the
     * "minimal valid input" for a given capability). Per-domain
     * batteries define their own fixture shapes.
     */
    readonly fixtures: Readonly<Record<string, unknown>>;
    /** Asserts a battery condition; collects failures into the report. */
    assert(condition: unknown, message: string): void;
}
export interface DomainCertificationAssertion {
    readonly id: string;
    readonly description: string;
    run(bundle: ConnectorBundle, harness: CertificationHarness): Promise<void>;
}
export interface DomainCertificationBattery {
    readonly domainSlug: string;
    readonly assertions: readonly DomainCertificationAssertion[];
}
//# sourceMappingURL=domainBattery.d.ts.map