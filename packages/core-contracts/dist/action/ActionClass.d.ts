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
export type CoreActionClass = 'read.local' | 'read.external_api' | 'read.tenant_db' | 'write.local.scratch' | 'write.local.repo_nonprod' | 'write.local.repo_prod' | 'write.external_api.nonprod' | 'write.external_api.prod' | 'write.tenant_db.nonprod' | 'write.tenant_db.prod' | 'comm.internal' | 'comm.external_email' | 'comm.external_message' | 'financial.payment' | 'personnel.access_grant' | 'personnel.access_revoke' | 'irreversible.delete_resource' | 'irreversible.public_publish' | 'deploy.nonprod' | 'deploy.prod' | 'unclassified';
export declare const CORE_ACTION_CLASSES: ReadonlySet<CoreActionClass>;
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
export type ExtendedActionClass = string & {
    readonly [ExtendedActionClassBrand]: true;
};
/** Public union; the type used throughout call sites. */
export type ActionClass = CoreActionClass | ExtendedActionClass;
/**
 * Default trust-ladder policy for an extended action class. Mirrors the
 * matrix in T.−1 PLATFORM_DEFAULTS but parameterised so each domain rule
 * pack declares its own cold-start posture.
 */
export interface TrustLadderPolicy {
    /** Mode for accountAgeDays < 7 (regardless of score). */
    readonly young: 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';
    /** Mode for accountAgeDays >= 7 + per-class score >= 0.6. */
    readonly withSignal: 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';
    /** Mode for accountAgeDays >= 30 + per-class score >= 0.85. */
    readonly established: 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';
    /**
     * When true, the class is also added to the always-require-approval
     * group at registry-load time — overrides the matrix entries above.
     * Set true for classes whose blast radius is irreversible (phi.write,
     * pci.cardholder_data_modify, …).
     */
    readonly alwaysRequireApproval?: boolean;
}
/**
 * Runtime declaration for a new extended action class registered by a
 * domain rule pack. The slug is a raw string here; `register()` brands
 * it to `ExtendedActionClass` and stores the (slug → declaration) pair.
 */
export interface ExtendedActionClassDeclaration {
    /** e.g. 'phi.read', 'pci.cardholder_data_access' — convention: 'namespace.verb'. */
    readonly slug: string;
    readonly description: string;
    readonly defaultPolicy: TrustLadderPolicy;
    /** Domain slug that owns this extension; informational. */
    readonly sourceDomain?: string;
}
/**
 * Minimal registry interface for extended action classes. Domain rule packs
 * (D.3) register policies here; the trust ladder consults the registry when
 * resolving an extended class.
 *
 * D.3 contract extension: adds `register()` and `lookup()`. Registration
 * is one-way — there is no `unregister()`. A platform restart is the
 * authoritative path for retiring a class.
 */
export interface IActionClassExtensionRegistry {
    isRegistered(slug: string): boolean;
    /**
     * Register an extended action class. Idempotent on identical slugs:
     * re-registering the same slug with an identical declaration is a
     * no-op; re-registering with a different declaration throws so
     * conflicting domain packs surface at load time.
     */
    register(decl: ExtendedActionClassDeclaration): void;
    /** Look up a declaration by slug; returns undefined when unregistered. */
    lookup(slug: string): ExtendedActionClassDeclaration | undefined;
}
/** Runtime validator + brand. Throws if `s` is not registered. */
export declare function asExtendedActionClass(s: string, registry: IActionClassExtensionRegistry): ExtendedActionClass;
/** Type guard used by exhaustive switches to fork on core vs extended. */
export declare function isCoreActionClass(c: ActionClass): c is CoreActionClass;
export {};
//# sourceMappingURL=ActionClass.d.ts.map