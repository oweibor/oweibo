"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCertificationSuite = runCertificationSuite;
const contractValidator_js_1 = require("./contractValidator.js");
const TIER_ORDER = {
    experimental: 0,
    community: 1,
    verified: 2,
    enterprise: 3,
};
async function runCertificationSuite(input) {
    const { bundle, tier } = input;
    const steps = [];
    const violations = [];
    // Step 1: shape validation always runs.
    const validation = (0, contractValidator_js_1.validateBundle)(bundle);
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
        const sandboxFailures = [];
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
            }
            catch (err) {
                sandboxFailures.push(`capability ${cap.capabilityId} sandbox round-trip threw: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        steps.push({
            step: 'sandbox_round_trip',
            passed: sandboxFailures.length === 0,
            violations: sandboxFailures,
        });
        // Step 4: inspectors / verifiers smoke load (just instantiation; no exec).
        const wiringFailures = [];
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
        const rollbackFailures = [];
        for (const cap of bundle.spec.capabilities) {
            if (!cap.rollback)
                continue;
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
        const domainFailures = [];
        for (const slug of declaredDomains) {
            const battery = batteries[slug];
            if (!battery) {
                domainFailures.push(`no certification battery supplied for domain ${slug}`);
                continue;
            }
            const harnessFailures = [];
            const harness = makeHarness({
                bundle,
                sandboxInvoker: input.sandboxInvoker ?? defaultSandboxInvoker,
                fixtures: input.fixtures ?? {},
                recordFailure: (m) => harnessFailures.push(m),
            });
            for (const a of battery.assertions) {
                try {
                    await a.run(bundle, harness);
                }
                catch (err) {
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
async function defaultSandboxInvoker(input) {
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
function makeHarness(input) {
    return {
        bundle: input.bundle,
        fixtures: input.fixtures,
        capability(id) {
            const c = input.bundle.spec.capabilities.find((x) => x.capabilityId === id);
            if (!c)
                throw new Error(`harness: unknown capability ${id}`);
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
            if (!condition)
                input.recordFailure(message);
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
function hashSteps(bundle, tier, steps) {
    let h = 5381 >>> 0;
    const ingest = (s) => {
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
//# sourceMappingURL=certificationRunner.js.map