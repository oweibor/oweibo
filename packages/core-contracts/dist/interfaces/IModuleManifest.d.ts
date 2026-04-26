/**
 * IModuleManifest — declared by every factory module.
 * Enforced at runtime by ScopedEventBus (event declaration) and
 * PluginRegistry (version compatibility checks).
 */
export interface IModuleManifest {
    /** Unique module identifier, e.g. 'module-billing' */
    readonly name: string;
    /** Semver version of this module */
    readonly version: string;
    /** Semver range of core-contracts this module was compiled against */
    readonly coreContractsVersion: string;
    /** Event types this module may publish on ScopedEventBus */
    readonly emits: readonly string[];
    /** Event types this module may subscribe to on ScopedEventBus */
    readonly consumes: readonly string[];
    /** Path to the module's ModuleKnowledge JSON artifact */
    readonly knowledgeArtifactPath: string;
    /** Optional kilo security context claims required to activate this module */
    readonly permissions?: readonly string[];
    /**
     * Optional npm/pnpm package dependency map, e.g. { "react": "^18.2.0" }.
     * Validated by DependencyConflictResolver at register() time against the
     * already-registered set to catch cross-plugin version conflicts (G18).
     */
    readonly dependencies?: Readonly<Record<string, string>>;
}
//# sourceMappingURL=IModuleManifest.d.ts.map