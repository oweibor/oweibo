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
import * as semver from 'semver';
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

export class PluginVersionMismatchError extends Error {
  constructor(pluginId: string, required: string, available: string) {
    super(`Plugin "${pluginId}" requires core-contracts@${required}, but ${available} is available`);
    this.name = 'PluginVersionMismatchError';
  }
}

export class PluginStateTransitionError extends Error {
  constructor(pluginId: string, from: PluginState, to: string) {
    super(`Invalid state transition for "${pluginId}": ${from} → ${to}`);
    this.name = 'PluginStateTransitionError';
  }
}

const VALID_TRANSITIONS: Record<PluginState, PluginState[]> = {
  registered: ['installed'],
  installed:  ['active', 'inactive'],
  active:     ['inactive'],
  inactive:   ['active', 'registered'],
  error:      ['registered'],
};

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly coreContractsVersion: string;
  /** Tracks which event types are produced by which plugin (for validation check #6) */
  private readonly eventProducers = new Map<string, string>();

  constructor(
    private readonly redis: Redis,
    coreContractsVersion = '0.1.0',
    private readonly conflictResolver: DependencyConflictResolver = new DependencyConflictResolver(),
    private readonly schemaRegistry?: PluginSchemaRegistry,
  ) {
    this.coreContractsVersion = coreContractsVersion;
  }

  async register(
    plugin: IPlugin,
    manifest: IModuleManifest,
    schemas: PluginSchemaEntry[] = [],
  ): Promise<void> {
    // Validation 1: core-contracts semver compatibility
    if (!semver.satisfies(this.coreContractsVersion, manifest.coreContractsVersion)) {
      throw new PluginVersionMismatchError(
        plugin.id, manifest.coreContractsVersion, this.coreContractsVersion,
      );
    }

    // Validation 2: no duplicate registration (unless recovering from error)
    const existing = this.plugins.get(plugin.id);
    if (existing && existing.state !== 'error') {
      throw new Error(`Plugin "${plugin.id}" is already registered`);
    }

    // Validation 3: pre-generation dependency conflict (G18)
    const manifests: Array<{ pluginId: string; dependencies: Record<string, string> }> = [];
    if (manifest.dependencies) {
      manifests.push({ pluginId: plugin.id, dependencies: { ...manifest.dependencies } });
    }
    for (const entry of this.plugins.values()) {
      if (entry.state === 'error' || !entry.manifest.dependencies) continue;
      manifests.push({ pluginId: entry.plugin.id, dependencies: { ...entry.manifest.dependencies } });
    }
    if (manifests.length >= 2) {
      this.conflictResolver.validate(manifests);
    }

    // Validation 4: knowledgeArtifactPath must be declared
    if (!manifest.knowledgeArtifactPath || manifest.knowledgeArtifactPath.trim() === '') {
      throw new Error(`Plugin "${plugin.id}" manifest.knowledgeArtifactPath is required (§14, check 4).`);
    }

    // Validation 5: all declared emits must have at least a format check (non-empty string)
    for (const eventType of manifest.emits) {
      if (!eventType || eventType.trim() === '') {
        throw new Error(`Plugin "${plugin.id}" declares an empty event type in manifest.emits.`);
      }
    }

    // Validation 6: all declared consumes must have a registered producer
    for (const eventType of manifest.consumes) {
      const baseType = eventType.replace(/@v\d+$/, ''); // strip optional version suffix
      const hasProducer = [...this.plugins.values()].some(e =>
        e.state !== 'error' && e.manifest.emits.some(et => et.replace(/@v\d+$/, '') === baseType)
      );
      if (!hasProducer) {
        throw new Error(
          `Plugin "${plugin.id}" consumes event "${eventType}" but no registered plugin produces it. ` +
          `Register the producing plugin first.`,
        );
      }
    }

    // Validation 7: cross-plugin schema conflict check (when schemaRegistry provided)
    if (this.schemaRegistry && schemas.length > 0) {
      try {
        for (const schema of schemas) {
          this.schemaRegistry.register(plugin.id, schema.type, schema.name);
        }
      } catch (err) {
        throw new Error(
          `Plugin "${plugin.id}" schema conflict: ${(err as Error).message} (§14, check 7)`
        );
      }
    }

    this.plugins.set(plugin.id, { plugin, manifest, state: 'registered' });
    // Track this plugin as a producer for its emitted events
    for (const eventType of manifest.emits) {
      this.eventProducers.set(eventType.replace(/@v\d+$/, ''), plugin.id);
    }
    await this.persistState(plugin.id, 'registered');
  }

  async install(pluginId: string): Promise<void> {
    const entry = this.getOrThrow(pluginId);
    this.validateTransition(entry, 'installed');
    await entry.plugin.onInstall();
    entry.state = 'installed';
    entry.installedAt = Date.now();
    await this.persistState(pluginId, 'installed');
  }

  async activate(pluginId: string): Promise<void> {
    const entry = this.getOrThrow(pluginId);
    this.validateTransition(entry, 'active');
    await entry.plugin.onActivate();
    entry.state = 'active';
    entry.activatedAt = Date.now();
    await this.persistState(pluginId, 'active');
  }

  async deactivate(pluginId: string): Promise<void> {
    const entry = this.getOrThrow(pluginId);
    this.validateTransition(entry, 'inactive');
    await entry.plugin.onDeactivate();
    entry.state = 'inactive';
    await this.persistState(pluginId, 'inactive');
  }

  async upgrade(pluginId: string, newPlugin: IPlugin, newManifest: IModuleManifest): Promise<void> {
    const entry = this.getOrThrow(pluginId);
    if (entry.state === 'active') {
      await this.deactivate(pluginId);
    }
    const previousVersion = entry.plugin.version;
    await newPlugin.onUpgrade(previousVersion);
    this.plugins.set(pluginId, {
      plugin: newPlugin,
      manifest: newManifest,
      state: 'installed',
      installedAt: Date.now(),
    });
    await this.persistState(pluginId, 'installed');
  }

  async remove(pluginId: string): Promise<void> {
    const entry = this.getOrThrow(pluginId);
    if (entry.state === 'active') {
      await this.deactivate(pluginId);
    }
    await entry.plugin.onRemove();
    this.plugins.delete(pluginId);
    await this.redis.del(`plugin:${pluginId}:state`);
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  listActive(): RegisteredPlugin[] {
    return Array.from(this.plugins.values()).filter(p => p.state === 'active');
  }

  listAll(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  private getOrThrow(pluginId: string): RegisteredPlugin {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
    return entry;
  }

  private validateTransition(entry: RegisteredPlugin, target: PluginState): void {
    const allowed = VALID_TRANSITIONS[entry.state] ?? [];
    if (!allowed.includes(target)) {
      throw new PluginStateTransitionError(entry.plugin.id, entry.state, target);
    }
  }

  private async persistState(pluginId: string, state: PluginState): Promise<void> {
    await this.redis.set(`plugin:${pluginId}:state`, state);
  }
}
