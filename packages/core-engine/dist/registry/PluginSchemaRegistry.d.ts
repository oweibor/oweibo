/**
 * PluginSchemaRegistry — cross-plugin schema conflict detection (§Gap 4).
 *
 * Tracks database tables, API route paths, and event types claimed by plugins.
 * Rejects registration when a conflict is detected — catches collisions at
 * install time rather than at runtime.
 */
export type SchemaResourceType = 'table' | 'route' | 'event';
export interface SchemaResource {
    readonly type: SchemaResourceType;
    readonly name: string;
    readonly pluginId: string;
    readonly registeredAt: number;
}
export declare class SchemaConflictError extends Error {
    readonly resourceType: SchemaResourceType;
    readonly resourceName: string;
    readonly existingPluginId: string;
    readonly conflictingPluginId: string;
    constructor(resourceType: SchemaResourceType, resourceName: string, existingPluginId: string, conflictingPluginId: string);
}
export declare class PluginSchemaRegistry {
    private readonly resources;
    register(pluginId: string, type: SchemaResourceType, name: string): void;
    registerBatch(pluginId: string, entries: Array<{
        type: SchemaResourceType;
        name: string;
    }>): void;
    unregister(pluginId: string): void;
    getByPlugin(pluginId: string): SchemaResource[];
    getByType(type: SchemaResourceType): SchemaResource[];
    hasConflict(type: SchemaResourceType, name: string, pluginId: string): boolean;
    getAllConflicts(pluginId: string, entries: Array<{
        type: SchemaResourceType;
        name: string;
    }>): SchemaConflictError[];
}
//# sourceMappingURL=PluginSchemaRegistry.d.ts.map