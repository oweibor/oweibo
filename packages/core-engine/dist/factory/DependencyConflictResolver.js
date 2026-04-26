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
exports.DependencyConflictResolver = exports.DependencyConflictError = void 0;
/**
 * DependencyConflictResolver — pre-generation plugin dependency validation (§3b, G18).
 *
 * Validates that all active plugin dependency trees are compatible before code
 * generation begins. Catches package.json version conflicts across plugins at
 * the ScaffoldInput gate, before the ArchitectAgent writes any code.
 */
const semver = __importStar(require("semver"));
class DependencyConflictError extends Error {
    conflicts;
    constructor(conflicts) {
        const summary = conflicts.map(c => `  ${c.packageName}: ${c.requiredBy.map(r => `${r.pluginId}@${r.version}`).join(' vs ')}`).join('\n');
        super(`[DependencyConflictResolver] ${conflicts.length} dependency conflict(s) detected:\n${summary}`);
        this.conflicts = conflicts;
        this.name = 'DependencyConflictError';
    }
}
exports.DependencyConflictError = DependencyConflictError;
class DependencyConflictResolver {
    validate(pluginManifests) {
        const versionMap = new Map();
        for (const { pluginId, dependencies } of pluginManifests) {
            for (const [pkg, version] of Object.entries(dependencies)) {
                const existing = versionMap.get(pkg) ?? [];
                existing.push({ pluginId, version });
                versionMap.set(pkg, existing);
            }
        }
        const conflicts = [];
        for (const [packageName, requirements] of versionMap) {
            if (requirements.length < 2)
                continue;
            // Check if all ranges are mutually satisfiable
            const ranges = requirements.map(r => r.version);
            if (!this.areRangesCompatible(ranges)) {
                conflicts.push({
                    packageName,
                    requiredBy: requirements,
                    resolutionHint: this.selectResolutionHint(packageName, requirements),
                });
            }
        }
        if (conflicts.length > 0) {
            throw new DependencyConflictError(conflicts);
        }
    }
    areRangesCompatible(ranges) {
        // Find a version that satisfies all ranges
        for (const range of ranges) {
            const minVersion = semver.minVersion(range);
            if (!minVersion)
                return false;
            const allSatisfied = ranges.every(r => semver.satisfies(minVersion.version, r));
            if (allSatisfied)
                return true;
        }
        // Try the max of each range
        for (const range of ranges) {
            const coerced = semver.coerce(range);
            if (!coerced)
                continue;
            const allSatisfied = ranges.every(r => semver.satisfies(coerced.version, r));
            if (allSatisfied)
                return true;
        }
        return false;
    }
    selectResolutionHint(packageName, requirements) {
        // Type polyfill packages
        if (packageName.startsWith('@types/'))
            return 'polyfill';
        const majors = new Set();
        for (const r of requirements) {
            const parsed = semver.coerce(r.version);
            if (parsed)
                majors.add(parsed.major);
        }
        // Same major version — pnpm override is safe
        if (majors.size <= 1)
            return 'pnpm-override';
        // Different major versions — check API surface complexity heuristic
        const commonLargeAPIs = ['react', 'express', 'next', 'vue', 'angular', 'webpack'];
        if (commonLargeAPIs.some(lib => packageName.includes(lib))) {
            return 'docker-isolation';
        }
        return 'adapter';
    }
}
exports.DependencyConflictResolver = DependencyConflictResolver;
//# sourceMappingURL=DependencyConflictResolver.js.map