/**
 * K.1 (ADR-012 §3.7) — SDK version + the N/N−1 compatibility predicate.
 *
 * The manifest's `sdkVersion` is checked at load by the platform registry
 * using this predicate; a connector outside the window is refused with a
 * clear upgrade path, never silently run. The predicate lives in the SDK
 * so the rule ships next to the version it governs.
 */

/** The SDK's own version. Bumped per §10.3 change-classes. */
export const SDK_VERSION = '1.1.0';

export interface SdkCompatibilityVerdict {
  readonly compatible: boolean;
  /** Human-readable refusal reason with the upgrade path, when refused. */
  readonly reason?: string;
}

/**
 * N/N−1 major-version window: a connector declaring the host's major or
 * the one before it is compatible; anything else is refused. Minor/patch
 * are backward-compatible by the §10.3 change-class rules, so only the
 * major participates in the window check. A malformed declaration is
 * refused (an unparseable claim is not a compatible claim).
 */
export function isSdkVersionCompatible(
  declared: string,
  hostVersion: string = SDK_VERSION,
): SdkCompatibilityVerdict {
  const d = parseMajor(declared);
  const h = parseMajor(hostVersion);
  if (h === null) {
    return { compatible: false, reason: `host SDK version ${hostVersion} is malformed` };
  }
  if (d === null) {
    return {
      compatible: false,
      reason: `manifest sdkVersion ${JSON.stringify(declared)} is not a semver — declare e.g. "${hostVersion}"`,
    };
  }
  if (d === h || d === h - 1) return { compatible: true };
  if (d > h) {
    return {
      compatible: false,
      reason: `connector requires SDK v${d} but this platform runs v${h} — upgrade the platform or build against v${h}`,
    };
  }
  return {
    compatible: false,
    reason: `connector was built against SDK v${d}; the N/N−1 window on this platform covers v${h}/v${h - 1} — rebuild against a supported SDK`,
  };
}

function parseMajor(version: string): number | null {
  const m = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version.trim());
  return m ? Number(m[1]) : null;
}
