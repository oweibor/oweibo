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
exports.ConnectorRegistry = void 0;
/**
 * T.2.f: ConnectorRegistry — in-memory catalog of platform-curated connectors.
 *
 * Loads `*.connector.json` files from a directory at startup, validates them,
 * exposes lookup + recommendation methods. The DB stores per-tenant instances
 * (oweibo.tenant_connectors); the catalog itself is code-shipped.
 *
 * Recommendation semantics: `recommend(templateSlug)` returns every catalog
 * entry whose `recommendedFor` array contains either the slug or `'*'`. The
 * SeedConnectorsStep writes those ids into tenant_bootstrap_steps.result so
 * the admin UI can render the recommendation list at onboarding time.
 */
const fs_1 = require("fs");
const path = __importStar(require("path"));
class ConnectorRegistry {
    entries;
    constructor(entries) {
        this.entries = entries;
    }
    static async loadFromDirectory(dir) {
        const files = await fs_1.promises.readdir(dir).catch((err) => {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        });
        const all = [];
        for (const f of files) {
            if (!f.endsWith('.connector.json'))
                continue;
            const raw = await fs_1.promises.readFile(path.join(dir, f), 'utf-8');
            const parsed = JSON.parse(raw);
            validateEntry(parsed, f);
            all.push(parsed);
        }
        assertConnectorIdsUnique(all);
        return new ConnectorRegistry(all);
    }
    static fromEntries(entries) {
        assertConnectorIdsUnique(entries);
        return new ConnectorRegistry(entries);
    }
    static defaultDirectory() {
        return path.join(__dirname, '..', 'seed', 'connectors');
    }
    /** Look up a single catalog entry by id. Returns null if not found. */
    get(connectorId) {
        return this.entries.find((e) => e.connectorId === connectorId) ?? null;
    }
    /** Look up a specific capability across the catalog. */
    getCapability(connectorId, capabilityId) {
        const entry = this.get(connectorId);
        if (!entry)
            return null;
        return entry.capabilities.find((c) => c.capabilityId === capabilityId) ?? null;
    }
    /**
     * Recommendation for a tenant: entries whose recommendedFor includes the
     * tenant's templateSlug or `'*'`. Order is the order entries were loaded,
     * which is filesystem-alphabetic from the catalog directory.
     */
    recommend(templateSlug) {
        return this.entries.filter((e) => e.recommendedFor.includes('*') || e.recommendedFor.includes(templateSlug));
    }
    /** All loaded catalog entries. */
    all() {
        return this.entries;
    }
    get size() {
        return this.entries.length;
    }
}
exports.ConnectorRegistry = ConnectorRegistry;
// ── Helpers ───────────────────────────────────────────────────────────────
function validateEntry(e, source) {
    if (!e || typeof e !== 'object') {
        throw new Error(`ConnectorRegistry: ${source} is not an object`);
    }
    const o = e;
    for (const k of ['connectorId', 'displayName', 'category', 'description', 'catalogVersion']) {
        if (typeof o[k] !== 'string' || o[k] === '') {
            throw new Error(`ConnectorRegistry: ${source} missing required string field ${k}`);
        }
    }
    if (!o.credentialSchema || typeof o.credentialSchema !== 'object') {
        throw new Error(`ConnectorRegistry: ${source} missing credentialSchema`);
    }
    if (!Array.isArray(o.capabilities) || o.capabilities.length === 0) {
        throw new Error(`ConnectorRegistry: ${source} has no capabilities`);
    }
    for (const cap of o.capabilities) {
        const c = cap;
        for (const k of ['capabilityId', 'summary', 'actionClass']) {
            if (typeof c[k] !== 'string' || c[k] === '') {
                throw new Error(`ConnectorRegistry: ${source} capability missing ${k}`);
            }
        }
    }
    if (!Array.isArray(o.recommendedFor)) {
        throw new Error(`ConnectorRegistry: ${source} missing recommendedFor`);
    }
}
function assertConnectorIdsUnique(entries) {
    const seen = new Set();
    for (const e of entries) {
        if (seen.has(e.connectorId)) {
            throw new Error(`ConnectorRegistry: duplicate connectorId ${e.connectorId}`);
        }
        seen.add(e.connectorId);
    }
}
//# sourceMappingURL=ConnectorRegistry.js.map