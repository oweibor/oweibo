/**
 * D.3 (domain-depth): in-memory implementation of
 * `IActionClassExtensionRegistry`.
 *
 * Domain rule packs register their extended action classes here at
 * platform boot. The registry is also queried (a) by
 * `asExtendedActionClass()` runtime validator, and (b) by the trust
 * ladder when resolving an extended class to its default trust mode.
 *
 * Idempotent on identical re-registration: a deployment that loads
 * two packs that both declare `phi.read` with identical config is
 * fine. Different config on the same slug throws so conflicting domain
 * packs surface at boot rather than silently shadowing.
 */
import type {
  ExtendedActionClassDeclaration,
  IActionClassExtensionRegistry,
} from '@oweibo/core-contracts';

export class ActionClassExtensionRegistry implements IActionClassExtensionRegistry {
  private readonly bySlug = new Map<string, ExtendedActionClassDeclaration>();

  isRegistered(slug: string): boolean {
    return this.bySlug.has(slug);
  }

  register(decl: ExtendedActionClassDeclaration): void {
    const existing = this.bySlug.get(decl.slug);
    if (existing) {
      if (!sameDeclaration(existing, decl)) {
        throw new Error(
          `ActionClassExtensionRegistry: conflicting declaration for slug ${JSON.stringify(decl.slug)} ` +
            `(existing from ${existing.sourceDomain ?? 'unknown'}, new from ${decl.sourceDomain ?? 'unknown'})`,
        );
      }
      return;
    }
    this.bySlug.set(decl.slug, decl);
  }

  lookup(slug: string): ExtendedActionClassDeclaration | undefined {
    return this.bySlug.get(slug);
  }

  /** All registered slugs in insertion order. */
  list(): readonly ExtendedActionClassDeclaration[] {
    return [...this.bySlug.values()];
  }
}

function sameDeclaration(
  a: ExtendedActionClassDeclaration,
  b: ExtendedActionClassDeclaration,
): boolean {
  if (a.slug !== b.slug) return false;
  if (a.description !== b.description) return false;
  if (!samePolicy(a.defaultPolicy, b.defaultPolicy)) return false;
  return true;
}

function samePolicy(
  a: ExtendedActionClassDeclaration['defaultPolicy'],
  b: ExtendedActionClassDeclaration['defaultPolicy'],
): boolean {
  return (
    a.young === b.young &&
    a.withSignal === b.withSignal &&
    a.established === b.established &&
    Boolean(a.alwaysRequireApproval) === Boolean(b.alwaysRequireApproval)
  );
}
