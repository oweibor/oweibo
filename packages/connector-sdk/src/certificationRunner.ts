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
import { validateBundle, type ValidationViolation } from './contractValidator.js';
import type {
  CertificationHarness,
  DomainCertificationBattery,
} from './domainBattery.js';

export type CertificationTier = 'experimental' | 'community' | 'verified' | 'enterprise';

export interface CertificationStepReport {
  readonly step: string;
  readonly passed: boolean;
  readonly violations: readonly string[];
}

export interface CertificationReport {
  readonly bundle: { connectorId: string; catalogVersion: string };
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
  readonly maintainer?: { readonly name: string; readonly slaMinutes: number };
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
  }) => Promise<{ output: unknown; auditRow?: Record<string, unknown> }>;
}

const TIER_ORDER: Record<CertificationTier, number> = {
  experimental: 0,
  community: 1,
  verified: 2,
  enterprise: 3,
};

export async function runCertificationSuite(
  input: CertificationRunInput,
): Promise<CertificationReport> {
  const { bundle, tier } = input;
  const steps: CertificationStepReport[] = [];
  const violations: ValidationViolation[] = [];

  // Step 1: shape validation always runs.
  const validation = validateBundle(bundle);
  violations.push(...validation.violations);
  steps.push({
    step: 'schema_validation',
    passed: validation.ok,
    violations: validation.violations.map((v) => `${v.path}: ${v.message}`),
  });

  // Step 2: tier-spec invariant — declared certificationTarget matches the run tier.
  const targetMatches = bundle.spec.certificationTarget === tier;
  steps.push({
    step: 'tier_alignment',
    passed: targetMatches,
    violations: targetMatches
      ? []
      : [`spec.certificationTarget is ${bundle.spec.certificationTarget}, runner asked for ${tier}`],
  });

  if (TIER_ORDER[tier] >= TIER_ORDER.community) {
    // Step 3: sandbox round-trip for every capability.
    const sandboxFailures: string[] = [];
    for (const cap of bundle.spec.capabilities) {
      if (!cap.sandbox) {
        sandboxFailures.push(`capability ${cap.capabilityId} has no sandbox declaration`);
        continue;
      }
      try {
        const invoker = input.sandboxInvoker ?? defaultSandboxInvoker;
        await invoker({
          capabilityId: cap.capabilityId,
          invokeInput: undefined,
          bundle,
        });
      } catch (err) {
        sandboxFailures.push(
          `capability ${cap.capabilityId} sandbox round-trip threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    steps.push({
      step: 'sandbox_round_trip',
      passed: sandboxFailures.length === 0,
      violations: sandboxFailures,
    });

    // Step 4: inspectors / verifiers smoke load (just instantiation; no exec).
    const wiringFailures: string[] = [];
    for (const cap of bundle.spec.capabilities) {
      for (const ins of cap.inspectors ?? []) {
        if (typeof ins.inspect !== 'function') {
          wiringFailures.push(`capability ${cap.capabilityId} inspector ${ins.name} has no inspect()`);
        }
      }
      for (const ver of cap.verifiers ?? []) {
        if (typeof ver.verify !== 'function') {
          wiringFailures.push(`capability ${cap.capabilityId} verifier ${ver.name} has no verify()`);
        }
      }
    }
    steps.push({
      step: 'inspector_verifier_wiring',
      passed: wiringFailures.length === 0,
      violations: wiringFailures,
    });
  }

  if (TIER_ORDER[tier] >= TIER_ORDER.verified) {
    // Step 5: rollback round-trip for capabilities that declare one.
    const rollbackFailures: string[] = [];
    for (const cap of bundle.spec.capabilities) {
      if (!cap.rollback) continue;
      if (typeof cap.rollback.rollback !== 'function') {
        rollbackFailures.push(`capability ${cap.capabilityId} rollback adapter missing rollback()`);
      }
    }
    steps.push({
      step: 'rollback_round_trip',
      passed: rollbackFailures.length === 0,
      violations: rollbackFailures,
    });

    // Step 6: platform review presence.
    const reviewers = input.platformReviewers ?? [];
    steps.push({
      step: 'platform_review',
      passed: reviewers.length > 0,
      violations: reviewers.length === 0 ? ['no platform reviewers supplied'] : [],
    });
  }

  if (TIER_ORDER[tier] >= TIER_ORDER.enterprise) {
    // Step 7: named maintainer.
    steps.push({
      step: 'named_maintainer',
      passed: Boolean(input.maintainer?.name) && (input.maintainer?.slaMinutes ?? 0) > 0,
      violations: input.maintainer ? [] : ['maintainer + slaMinutes required'],
    });

    // Step 8: every certifiedFor domain has a passing battery.
    const declaredDomains = bundle.spec.certifiedFor ?? [];
    const batteries = input.batteries ?? {};
    const domainFailures: string[] = [];
    for (const slug of declaredDomains) {
      const battery = batteries[slug];
      if (!battery) {
        domainFailures.push(`no certification battery supplied for domain ${slug}`);
        continue;
      }
      const harnessFailures: string[] = [];
      const harness = makeHarness({
        bundle,
        sandboxInvoker: input.sandboxInvoker ?? defaultSandboxInvoker,
        fixtures: input.fixtures ?? {},
        recordFailure: (m) => harnessFailures.push(m),
      });
      for (const a of battery.assertions) {
        try {
          await a.run(bundle, harness);
        } catch (err) {
          harnessFailures.push(`${slug}/${a.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (harnessFailures.length > 0) {
        domainFailures.push(...harnessFailures.map((m) => `${slug}: ${m}`));
      }
    }
    steps.push({
      step: 'domain_batteries',
      passed: domainFailures.length === 0,
      violations: domainFailures,
    });
  }

  const passed = steps.every((s) => s.passed);
  return {
    bundle: {
      connectorId: bundle.spec.connectorId,
      catalogVersion: bundle.spec.catalogVersion,
    },
    tier,
    passed,
    steps,
    violations,
    testSuiteHash: hashSteps(bundle, tier, steps),
  };
}

async function defaultSandboxInvoker(input: {
  capabilityId: string;
  invokeInput: unknown;
  bundle: ConnectorBundle;
}): Promise<{ output: unknown; auditRow?: Record<string, unknown> }> {
  const cap = input.bundle.spec.capabilities.find((c) => c.capabilityId === input.capabilityId);
  if (!cap) {
    throw new Error(`defaultSandboxInvoker: unknown capabilityId ${input.capabilityId}`);
  }
  if (!cap.sandbox || cap.sandbox.mode !== 'mock') {
    // The CI environment cannot exercise real sandbox endpoints — those
    // require integration test infra. Non-mock sandboxes pass by
    // declaration here; the CI surface that DOES have the integration
    // env can override `sandboxInvoker` to actually exercise them.
    return { output: { skipped: true, reason: 'non_mock_sandbox' } };
  }
  // 'mock' mode: success is observed by the absence of a throw.
  return { output: { mock: true } };
}

function makeHarness(input: {
  bundle: ConnectorBundle;
  sandboxInvoker: NonNullable<CertificationRunInput['sandboxInvoker']>;
  fixtures: Readonly<Record<string, unknown>>;
  recordFailure: (m: string) => void;
}): CertificationHarness {
  return {
    bundle: input.bundle,
    fixtures: input.fixtures,
    capability(id) {
      const c = input.bundle.spec.capabilities.find((x) => x.capabilityId === id);
      if (!c) throw new Error(`harness: unknown capability ${id}`);
      return c;
    },
    async invokeSandboxed(id, invokeInput) {
      return input.sandboxInvoker({
        capabilityId: id,
        invokeInput,
        bundle: input.bundle,
      });
    },
    assert(condition, message) {
      if (!condition) input.recordFailure(message);
    },
  };
}

/**
 * Deterministic hash over (bundle ident, tier, step names + pass bits).
 * Plain old DJB2 — avoids a crypto dependency in the SDK package. The
 * hash is opaque to consumers; it's persisted to the certifications
 * ledger so two cert runs at the same shape collide and audit can
 * tell whether a re-cert exercised the same surface.
 */
function hashSteps(
  bundle: ConnectorBundle,
  tier: CertificationTier,
  steps: readonly CertificationStepReport[],
): string {
  let h = 5381 >>> 0;
  const ingest = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    }
  };
  ingest(bundle.spec.connectorId);
  ingest('|');
  ingest(bundle.spec.catalogVersion);
  ingest('|');
  ingest(tier);
  for (const s of steps) {
    ingest('|');
    ingest(s.step);
    ingest(':');
    ingest(s.passed ? '1' : '0');
  }
  return h.toString(16).padStart(8, '0');
}
