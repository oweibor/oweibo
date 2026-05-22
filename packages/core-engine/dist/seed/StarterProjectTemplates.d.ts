/**
 * T.2.b: per-template invariants for the starter project SeedProjectStep
 * installs. These map the tenant_bootstrap.template_slug to a small set of
 * key→value facts the agent gets to start with. Templates that aren't in
 * the registry fall back to BASELINE_INVARIANTS.
 *
 * The full template catalog ships in T.6; this file is the minimal bridge
 * so day-one onboarding has *some* invariants to point at. Adding a new
 * template here is a one-line change.
 */
export interface StarterProjectSpec {
    readonly name: string;
    readonly description: string;
    readonly invariants: Readonly<Record<string, string>>;
    readonly tags: readonly string[];
}
export declare function starterProjectSpec(templateSlug: string): StarterProjectSpec;
/** Read-only list of template slugs the starter registry knows about. */
export declare const STARTER_TEMPLATE_SLUGS: readonly string[];
//# sourceMappingURL=StarterProjectTemplates.d.ts.map