"use strict";
/**
 * PluginSchemaRegistry — cross-plugin schema conflict detection (§Gap 4).
 *
 * Tracks database tables, API route paths, and event types claimed by plugins.
 * Rejects registration when a conflict is detected — catches collisions at
 * install time rather than at runtime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginSchemaRegistry = exports.SchemaConflictError = void 0;
class SchemaConflictError extends Error {
    resourceType;
    resourceName;
    existingPluginId;
    conflictingPluginId;
    constructor(resourceType, resourceName, existingPluginId, conflictingPluginId) {
        super(`[SchemaConflict] ${resourceType} "${resourceName}" is already claimed by ` +
            `plugin "${existingPluginId}" — cannot register for "${conflictingPluginId}". ` +
            `Resolve by renaming the resource or using a plugin namespace prefix.`);
        this.resourceType = resourceType;
        this.resourceName = resourceName;
        this.existingPluginId = existingPluginId;
        this.conflictingPluginId = conflictingPluginId;
        this.name = 'SchemaConflictError';
    }
}
exports.SchemaConflictError = SchemaConflictError;
class PluginSchemaRegistry {
    resources = new Map();
    register(pluginId, type, name) {
        const key = `${type}:${name}`;
        const existing = this.resources.get(key);
        if (existing && existing.pluginId !== pluginId) {
            throw new SchemaConflictError(type, name, existing.pluginId, pluginId);
        }
        this.resources.set(key, { type, name, pluginId, registeredAt: Date.now() });
    }
    registerBatch(pluginId, entries) {
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
    unregister(pluginId) {
        for (const [key, resource] of this.resources) {
            if (resource.pluginId === pluginId) {
                this.resources.delete(key);
            }
        }
    }
    getByPlugin(pluginId) {
        return Array.from(this.resources.values()).filter(r => r.pluginId === pluginId);
    }
    getByType(type) {
        return Array.from(this.resources.values()).filter(r => r.type === type);
    }
    hasConflict(type, name, pluginId) {
        const key = `${type}:${name}`;
        const existing = this.resources.get(key);
        return !!existing && existing.pluginId !== pluginId;
    }
    getAllConflicts(pluginId, entries) {
        const conflicts = [];
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
exports.PluginSchemaRegistry = PluginSchemaRegistry;
//# sourceMappingURL=PluginSchemaRegistry.js.map