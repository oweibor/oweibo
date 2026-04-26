"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginRegistry = exports.PluginStateTransitionError = exports.PluginVersionMismatchError = void 0;
const semver = __importStar(require("semver"));
const DependencyConflictResolver_js_1 = require("../factory/DependencyConflictResolver.js");
class PluginVersionMismatchError extends Error {
    constructor(pluginId, required, available) {
        super(`Plugin "${pluginId}" requires core-contracts@${required}, but ${available} is available`);
        this.name = 'PluginVersionMismatchError';
    }
}
exports.PluginVersionMismatchError = PluginVersionMismatchError;
class PluginStateTransitionError extends Error {
    constructor(pluginId, from, to) {
        super(`Invalid state transition for "${pluginId}": ${from} → ${to}`);
        this.name = 'PluginStateTransitionError';
    }
}
exports.PluginStateTransitionError = PluginStateTransitionError;
const VALID_TRANSITIONS = {
    registered: ['installed'],
    installed: ['active', 'inactive'],
    active: ['inactive'],
    inactive: ['active', 'registered'],
    error: ['registered'],
};
class PluginRegistry {
    redis;
    conflictResolver;
    schemaRegistry;
    plugins = new Map();
    coreContractsVersion;
    /** Tracks which event types are produced by which plugin (for validation check #6) */
    eventProducers = new Map();
    constructor(redis, coreContractsVersion = '0.1.0', conflictResolver = new DependencyConflictResolver_js_1.DependencyConflictResolver(), schemaRegistry) {
        this.redis = redis;
        this.conflictResolver = conflictResolver;
        this.schemaRegistry = schemaRegistry;
        this.coreContractsVersion = coreContractsVersion;
    }
    async register(plugin, manifest, schemas = []) {
        // Validation 1: core-contracts semver compatibility
        if (!semver.satisfies(this.coreContractsVersion, manifest.coreContractsVersion)) {
            throw new PluginVersionMismatchError(plugin.id, manifest.coreContractsVersion, this.coreContractsVersion);
        }
        // Validation 2: no duplicate registration (unless recovering from error)
        const existing = this.plugins.get(plugin.id);
        if (existing && existing.state !== 'error') {
            throw new Error(`Plugin "${plugin.id}" is already registered`);
        }
        // Validation 3: pre-generation dependency conflict (G18)
        const manifests = [];
        if (manifest.dependencies) {
            manifests.push({ pluginId: plugin.id, dependencies: { ...manifest.dependencies } });
        }
        for (const entry of this.plugins.values()) {
            if (entry.state === 'error' || !entry.manifest.dependencies)
                continue;
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
            const hasProducer = [...this.plugins.values()].some(e => e.state !== 'error' && e.manifest.emits.some(et => et.replace(/@v\d+$/, '') === baseType));
            if (!hasProducer) {
                throw new Error(`Plugin "${plugin.id}" consumes event "${eventType}" but no registered plugin produces it. ` +
                    `Register the producing plugin first.`);
            }
        }
        // Validation 7: cross-plugin schema conflict check (when schemaRegistry provided)
        if (this.schemaRegistry && schemas.length > 0) {
            try {
                for (const schema of schemas) {
                    this.schemaRegistry.register(plugin.id, schema.type, schema.name);
                }
            }
            catch (err) {
                throw new Error(`Plugin "${plugin.id}" schema conflict: ${err.message} (§14, check 7)`);
            }
        }
        this.plugins.set(plugin.id, { plugin, manifest, state: 'registered' });
        // Track this plugin as a producer for its emitted events
        for (const eventType of manifest.emits) {
            this.eventProducers.set(eventType.replace(/@v\d+$/, ''), plugin.id);
        }
        await this.persistState(plugin.id, 'registered');
    }
    async install(pluginId) {
        const entry = this.getOrThrow(pluginId);
        this.validateTransition(entry, 'installed');
        await entry.plugin.onInstall();
        entry.state = 'installed';
        entry.installedAt = Date.now();
        await this.persistState(pluginId, 'installed');
    }
    async activate(pluginId) {
        const entry = this.getOrThrow(pluginId);
        this.validateTransition(entry, 'active');
        await entry.plugin.onActivate();
        entry.state = 'active';
        entry.activatedAt = Date.now();
        await this.persistState(pluginId, 'active');
    }
    async deactivate(pluginId) {
        const entry = this.getOrThrow(pluginId);
        this.validateTransition(entry, 'inactive');
        await entry.plugin.onDeactivate();
        entry.state = 'inactive';
        await this.persistState(pluginId, 'inactive');
    }
    async upgrade(pluginId, newPlugin, newManifest) {
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
    async remove(pluginId) {
        const entry = this.getOrThrow(pluginId);
        if (entry.state === 'active') {
            await this.deactivate(pluginId);
        }
        await entry.plugin.onRemove();
        this.plugins.delete(pluginId);
        await this.redis.del(`plugin:${pluginId}:state`);
    }
    get(pluginId) {
        return this.plugins.get(pluginId);
    }
    listActive() {
        return Array.from(this.plugins.values()).filter(p => p.state === 'active');
    }
    listAll() {
        return Array.from(this.plugins.values());
    }
    getOrThrow(pluginId) {
        const entry = this.plugins.get(pluginId);
        if (!entry)
            throw new Error(`Plugin "${pluginId}" not found`);
        return entry;
    }
    validateTransition(entry, target) {
        const allowed = VALID_TRANSITIONS[entry.state] ?? [];
        if (!allowed.includes(target)) {
            throw new PluginStateTransitionError(entry.plugin.id, entry.state, target);
        }
    }
    async persistState(pluginId, state) {
        await this.redis.set(`plugin:${pluginId}:state`, state);
    }
}
exports.PluginRegistry = PluginRegistry;
//# sourceMappingURL=PluginRegistry.js.map