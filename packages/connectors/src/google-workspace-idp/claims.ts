/**
 * K.2 — OIDC login-claim mapping for the Google Workspace IdP connector
 * (ADR-010 §3.6).
 *
 * OIDC supplies LOGIN IDENTITY ONLY: `sub` → stable principal id,
 * `email` + `email_verified` → the canonical seed, `hd` → tenant-domain
 * check. Group claims in ID tokens are NEVER consumed — they truncate
 * (Azure's 200-group limit is the canonical failure), don't carry
 * nesting, and vary by IdP. Membership ground truth comes from the
 * Directory API through the PrincipalsPort. This mapper deliberately has
 * no parameter through which a groups claim could even arrive.
 */

export interface OidcLoginClaims {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  /** Google Workspace hosted-domain claim. */
  readonly hd?: string;
}

export type MappedLoginIdentity =
  | {
      readonly ok: true;
      /** Source-native stable principal id (the OIDC subject). */
      readonly principalId: string;
      /** Verified email — the ONLY cross-source seed pre-K.8 (ADR-002 owns the rest). */
      readonly verifiedEmail: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Map OIDC claims to a login identity. `expectedDomain`, when set,
 * enforces the `hd` check (a token from outside the tenant's Workspace
 * domain is refused even if cryptographically valid — signature
 * verification happened upstream in the identity service; this is the
 * tenant-binding half).
 */
export function mapOidcLoginClaims(
  claims: OidcLoginClaims,
  expectedDomain?: string,
): MappedLoginIdentity {
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    return { ok: false, reason: 'missing sub claim — no stable principal id' };
  }
  if (expectedDomain !== undefined && claims.hd !== expectedDomain) {
    return {
      ok: false,
      reason: `hd claim ${JSON.stringify(claims.hd ?? null)} does not match tenant domain ${JSON.stringify(expectedDomain)}`,
    };
  }
  // An unverified email is not a seed — carry null rather than a claim
  // the source itself won't stand behind.
  const verifiedEmail =
    typeof claims.email === 'string' && claims.email.length > 0 && claims.email_verified === true
      ? claims.email.toLowerCase()
      : null;
  return { ok: true, principalId: claims.sub, verifiedEmail };
}
