/**
 * T.−1: Action class taxonomy for the action trust ladder.
 *
 * Closed string-literal union; exhaustive switching is enforced at compile time
 * via the TypeScript `never` branch pattern. Additions to this set require
 * a contract change.
 *
 * Domain-specific classes (e.g. 'phi.read', 'pci.cardholder_data_access') are
 * declared by domain rule packs at runtime as `ExtendedActionClass` — they are
 * branded strings, not members of CoreActionClass.
 */
export type CoreActionClass =
  // Read classes — no side effects
  | 'read.local'
  | 'read.external_api'
  | 'read.tenant_db'
  // Write classes — reversible local
  | 'write.local.scratch'
  | 'write.local.repo_nonprod'
  | 'write.local.repo_prod'
  // Write classes — external reversible
  | 'write.external_api.nonprod'
  | 'write.external_api.prod'
  | 'write.tenant_db.nonprod'
  | 'write.tenant_db.prod'
  // Communication
  | 'comm.internal'
  | 'comm.external_email'
  | 'comm.external_message'
  // Financial / personnel / irreversible
  | 'financial.payment'
  | 'personnel.access_grant'
  | 'personnel.access_revoke'
  | 'irreversible.delete_resource'
  | 'irreversible.public_publish'
  // Code deploy
  | 'deploy.nonprod'
  | 'deploy.prod'
  // Catch-all — forces require_approval until classified
  | 'unclassified';

export const CORE_ACTION_CLASSES: ReadonlySet<CoreActionClass> = new Set<CoreActionClass>([
  'read.local',
  'read.external_api',
  'read.tenant_db',
  'write.local.scratch',
  'write.local.repo_nonprod',
  'write.local.repo_prod',
  'write.external_api.nonprod',
  'write.external_api.prod',
  'write.tenant_db.nonprod',
  'write.tenant_db.prod',
  'comm.internal',
  'comm.external_email',
  'comm.external_message',
  'financial.payment',
  'personnel.access_grant',
  'personnel.access_revoke',
  'irreversible.delete_resource',
  'irreversible.public_publish',
  'deploy.nonprod',
  'deploy.prod',
  'unclassified',
]);

declare const ExtendedActionClassBrand: unique symbol;

/**
 * Domain-extended action class. Branded so a raw string cannot accidentally
 * be passed where an extended class is required, and so the TypeScript
 * compiler treats the brand as opaque (no exhaustive-switch collisions
 * with CoreActionClass).
 *
 * Construction goes through {@link asExtendedActionClass} which validates
 * against a registry at runtime.
 */
export type ExtendedActionClass = string & { readonly [ExtendedActionClassBrand]: true };

/** Public union; the type used throughout call sites. */
export type ActionClass = CoreActionClass | ExtendedActionClass;

/**
 * Minimal registry interface for extended action classes. Domain rule packs
 * (D.3) register policies here; the trust ladder consults the registry when
 * resolving an extended class.
 */
export interface IActionClassExtensionRegistry {
  isRegistered(slug: string): boolean;
}

/** Runtime validator + brand. Throws if `s` is not registered. */
export function asExtendedActionClass(
  s: string,
  registry: IActionClassExtensionRegistry,
): ExtendedActionClass {
  if (!registry.isRegistered(s)) {
    throw new Error(`Unknown extended action class: ${s}`);
  }
  return s as ExtendedActionClass;
}

/** Type guard used by exhaustive switches to fork on core vs extended. */
export function isCoreActionClass(c: ActionClass): c is CoreActionClass {
  return CORE_ACTION_CLASSES.has(c as CoreActionClass);
}
