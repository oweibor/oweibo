export interface DependencyConflict {
    readonly packageName: string;
    readonly requiredBy: Array<{
        pluginId: string;
        version: string;
    }>;
    readonly resolutionHint: 'polyfill' | 'adapter' | 'docker-isolation' | 'pnpm-override';
}
export declare class DependencyConflictError extends Error {
    readonly conflicts: DependencyConflict[];
    constructor(conflicts: DependencyConflict[]);
}
export declare class DependencyConflictResolver {
    validate(pluginManifests: Array<{
        pluginId: string;
        dependencies: Record<string, string>;
    }>): void;
    private areRangesCompatible;
    private selectResolutionHint;
}
//# sourceMappingURL=DependencyConflictResolver.d.ts.map