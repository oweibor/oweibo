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

export class SchemaConflictError extends Error {
  constructor(
    public readonly resourceType: SchemaResourceType,
    public readonly resourceName: string,
    public readonly existingPluginId: string,
    public readonly conflictingPluginId: string,
  ) {
    super(
      `[SchemaConflict] ${resourceType} "${resourceName}" is already claimed by ` +
      `plugin "${existingPluginId}" — cannot register for "${conflictingPluginId}". ` +
      `Resolve by renaming the resource or using a plugin namespace prefix.`,
    );
    this.name = 'SchemaConflictError';
  }
}

export class PluginSchemaRegistry {
  private readonly resources = new Map<string, SchemaResource>();

  register(pluginId: string, type: SchemaResourceType, name: string): void {
    const key = `${type}:${name}`;
    const existing = this.resources.get(key);
    if (existing && existing.pluginId !== pluginId) {
      throw new SchemaConflictError(type, name, existing.pluginId, pluginId);
    }
    this.resources.set(key, { type, name, pluginId, registeredAt: Date.now() });
  }

  registerBatch(
    pluginId: string,
    entries: Array<{ type: SchemaResourceType; name: string }>,
  ): void {
    // Validate all before committing any
    for (const { type, name } of entries) {
      const key = `${type}:${name}`;
      const existing = this.resources.get(key);
      if (existing && existing.pluginId !== pluginId) {
        throw new SchemaConflictError(type, name, existing.pluginId, pluginId);
      }
    }
    for (const { type, name } of entries) {
      this.register(pluginId, type, name);
    }
  }

  unregister(pluginId: string): void {
    for (const [key, resource] of this.resources) {
      if (resource.pluginId === pluginId) {
        this.resources.delete(key);
      }
    }
  }

  getByPlugin(pluginId: string): SchemaResource[] {
    return Array.from(this.resources.values()).filter(r => r.pluginId === pluginId);
  }

  getByType(type: SchemaResourceType): SchemaResource[] {
    return Array.from(this.resources.values()).filter(r => r.type === type);
  }

  hasConflict(type: SchemaResourceType, name: string, pluginId: string): boolean {
    const key = `${type}:${name}`;
    const existing = this.resources.get(key);
    return !!existing && existing.pluginId !== pluginId;
  }

  getAllConflicts(
    pluginId: string,
    entries: Array<{ type: SchemaResourceType; name: string }>,
  ): SchemaConflictError[] {
    const conflicts: SchemaConflictError[] = [];
    for (const { type, name } of entries) {
      const key = `${type}:${name}`;
      const existing = this.resources.get(key);
      if (existing && existing.pluginId !== pluginId) {
        conflicts.push(new SchemaConflictError(type, name, existing.pluginId, pluginId));
      }
    }
    return conflicts;
  }
}
