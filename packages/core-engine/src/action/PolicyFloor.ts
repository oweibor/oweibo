/**
 * F.4.4: shared floor primitives for the four tenant policy override
 * surfaces (SLA / multiparty / ratelimit / quota).
 *
 * Each service exports its own PLATFORM_MIN_MATRIX constant. The
 * check* helpers below produce a consistent `PolicyFloorViolation[]`
 * shape so the route handler can map the structured error to
 * HTTP 400 `policy_below_platform_floor` regardless of which policy
 * domain the request targeted.
 *
 * A floor violation describes ONE field-level breach. PUT requests
 * that violate multiple constraints surface every breach at once so
 * an operator can fix the policy in one round-trip.
 */

export interface PolicyFloorViolation {
  /** Dot-path into the policy payload, e.g. 'hardExpireAfterSeconds'. */
  readonly field: string;
  /** Operator-readable message. */
  readonly message: string;
  /** Suggested floor value (number, or set membership). */
  readonly floor: number | readonly string[];
  /** The value the caller supplied. */
  readonly supplied: number | string;
}

/**
 * Service-layer error thrown by upsert helpers when the candidate
 * policy violates the platform floor. The route handler unwraps the
 * `violations` array and surfaces them in the 400 response body.
 */
export class PolicyBelowFloorError extends Error {
  public readonly code = 'policy_below_platform_floor' as const;
  constructor(
    public readonly policyDomain: 'sla' | 'multiparty' | 'ratelimit' | 'quota',
    public readonly actionClass: string,
    public readonly violations: readonly PolicyFloorViolation[],
  ) {
    super(`policy_below_platform_floor: ${policyDomain}/${actionClass} (${violations.length} violation(s))`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
