/**
 * ADR-012 SDK contract predicate — manifest truthfulness (INV-15).
 *
 * This is the *contract*, not the machinery: a pure, dependency-free expression
 * of "a manifest capability is true iff its adapter exists and passes
 * certification," shipped and verified green at ADR-012 ratification. The
 * certification harness that runs port probes and feeds `demonstrated` into
 * this check is the K.1 deliverable.
 *
 * Rule (INV-15): every capability the manifest *declares* (`supports[flag] ===
 * true`) MUST be *demonstrated* (its certification probe passed). A declared
 * flag with no demonstration is a violation, and any violation fails
 * certification. The reverse — demonstrated but not declared — is not a
 * violation (an unused, honestly-omitted capability); it is reported
 * separately as an informational note, never as a failure.
 */

/** The capability/port claims a manifest can make (ADR-012 §3.3). */
export type SupportFlag =
  | 'changeFeed'
  | 'content'
  | 'acl'
  | 'principals'
  | 'activity'
  | 'actions'
  | 'deltaSync'
  | 'webhooks'
  | 'groups'
  | 'activitySignals';

export type SupportMap = Readonly<Partial<Record<SupportFlag, boolean>>>;

export interface ManifestTruthfulnessViolation {
  readonly flag: SupportFlag;
  readonly message: string;
}

export interface ManifestTruthfulnessReport {
  /** True iff no declared capability lacks a demonstration. */
  readonly ok: boolean;
  /** Declared-but-not-demonstrated — these fail certification. */
  readonly violations: readonly ManifestTruthfulnessViolation[];
  /** Demonstrated-but-not-declared — informational, never a failure. */
  readonly undeclared: readonly SupportFlag[];
}

const ALL_FLAGS: readonly SupportFlag[] = [
  'changeFeed', 'content', 'acl', 'principals', 'activity',
  'actions', 'deltaSync', 'webhooks', 'groups', 'activitySignals',
];

/**
 * INV-15 checker. Compares what the manifest declares against what
 * certification demonstrated.
 */
export function checkManifestTruthfulness(
  declared: SupportMap,
  demonstrated: SupportMap,
): ManifestTruthfulnessReport {
  const violations: ManifestTruthfulnessViolation[] = [];
  const undeclared: SupportFlag[] = [];

  for (const flag of ALL_FLAGS) {
    const isDeclared = declared[flag] === true;
    const isDemonstrated = demonstrated[flag] === true;

    if (isDeclared && !isDemonstrated) {
      violations.push({
        flag,
        message: `manifest declares '${flag}' but certification did not demonstrate it (INV-15)`,
      });
    } else if (!isDeclared && isDemonstrated) {
      undeclared.push(flag);
    }
  }

  return { ok: violations.length === 0, violations, undeclared };
}
