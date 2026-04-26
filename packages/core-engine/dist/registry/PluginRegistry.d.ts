/**
 * PluginRegistry — runtime plugin lifecycle manager (§4, §14, Principle #3).
 *
 * Enforces 7 registration validations before any state mutation:
 *   1. Core-contracts semver compatibility
 *   2. No duplicate registration (unless in error state)
 *   3. Pre-generation dependency conflict (DependencyConflictResolver / G18)
 *   4. knowledgeArtifactPath declared
 *   5. All declared emits have registered event schemas
 *   6. All declared consumes have a registered producer
 *   7. Cross-plugin schema conflict (PluginSchemaRegistry, when provided)
 *
 * State machine: registered → installed → active ⇄ inactive → (remove)
 * Thread-safe via Redis-backed state.
 */
import type { IPlugin, IModuleManifest } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
import { DependencyConflictResolver } from '../factory/DependencyConflictResolver.js';
import type { PluginSchemaRegistry, SchemaResourceType } from './PluginSchemaRegistry.js';
/** Minimal schema resource descriptor passed to register() — pluginId is filled in by PluginRegistry. */
export interface PluginSchemaEntry {
    type: SchemaResourceType;
    name: string;
}
export type PluginState = 'registered' | 'installed' | 'active' | 'inactive' | 'error';
export interface RegisteredPlugin {
    readonly plugin: IPlugin;
    readonly manifest: IModuleManifest;
    state: PluginState;
    installedAt?: number;
    activatedAt?: number;
    error?: string;
}
export declare class PluginVersionMismatchError extends Error {
    constructor(pluginId: string, required: string, available: string);
}
export declare class PluginStateTransitionError extends Error {
    constructor(pluginId: string, from: PluginState, to: string);
}
export declare class PluginRegistry {
    private readonly redis;
    private readonly conflictResolver;
    private readonly schemaRegistry?;
    private readonly plugins;
    private readonly coreContractsVersion;
    /** Tracks which event types are produced by which plugin (for validation check #6) */
    private readonly eventProducers;
    constructor(redis: Redis, coreContractsVersion?: string, conflictResolver?: DependencyConflictResolver, schemaRegistry?: PluginSchemaRegistry | undefined);
    register(plugin: IPlugin, manifest: IModuleManifest, schemas?: PluginSchemaEntry[]): Promise<void>;
    install(pluginId: string): Promise<void>;
    activate(pluginId: string): Promise<void>;
    deactivate(pluginId: string): Promise<void>;
    upgrade(pluginId: string, newPlugin: IPlugin, newManifest: IModuleManifest): Promise<void>;
    remove(pluginId: string): Promise<void>;
    get(pluginId: string): RegisteredPlugin | undefined;
    listActive(): RegisteredPlugin[];
    listAll(): RegisteredPlugin[];
    private getOrThrow;
    private validateTransition;
    private persistState;
}
//# sourceMappingURL=PluginRegistry.d.ts.map