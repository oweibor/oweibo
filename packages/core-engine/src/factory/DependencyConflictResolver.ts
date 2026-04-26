/**
 * DependencyConflictResolver — pre-generation plugin dependency validation (§3b, G18).
 *
 * Validates that all active plugin dependency trees are compatible before code
 * generation begins. Catches package.json version conflicts across plugins at
 * the ScaffoldInput gate, before the ArchitectAgent writes any code.
 */
import * as semver from 'semver';

export interface DependencyConflict {
  readonly packageName: string;
  readonly requiredBy: Array<{ pluginId: string; version: string }>;
  readonly resolutionHint: 'polyfill' | 'adapter' | 'docker-isolation' | 'pnpm-override';
}

export class DependencyConflictError extends Error {
  constructor(public readonly conflicts: DependencyConflict[]) {
    const summary = conflicts.map(c =>
      `  ${c.packageName}: ${c.requiredBy.map(r => `${r.pluginId}@${r.version}`).join(' vs ')}`,
    ).join('\n');
    super(`[DependencyConflictResolver] ${conflicts.length} dependency conflict(s) detected:\n${summary}`);
    this.name = 'DependencyConflictError';
  }
}

export class DependencyConflictResolver {
  validate(
    pluginManifests: Array<{ pluginId: string; dependencies: Record<string, string> }>,
  ): void {
    const versionMap = new Map<string, Array<{ pluginId: string; version: string }>>();

    for (const { pluginId, dependencies } of pluginManifests) {
      for (const [pkg, version] of Object.entries(dependencies)) {
        const existing = versionMap.get(pkg) ?? [];
        existing.push({ pluginId, version });
        versionMap.set(pkg, existing);
      }
    }

    const conflicts: DependencyConflict[] = [];
    for (const [packageName, requirements] of versionMap) {
      if (requirements.length < 2) continue;

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

  private areRangesCompatible(ranges: string[]): boolean {
    // Find a version that satisfies all ranges
    for (const range of ranges) {
      const minVersion = semver.minVersion(range);
      if (!minVersion) return false;
      const allSatisfied = ranges.every(r => semver.satisfies(minVersion.version, r));
      if (allSatisfied) return true;
    }

    // Try the max of each range
    for (const range of ranges) {
      const coerced = semver.coerce(range);
      if (!coerced) continue;
      const allSatisfied = ranges.every(r => semver.satisfies(coerced.version, r));
      if (allSatisfied) return true;
    }

    return false;
  }

  private selectResolutionHint(
    packageName: string,
    requirements: Array<{ pluginId: string; version: string }>,
  ): DependencyConflict['resolutionHint'] {
    // Type polyfill packages
    if (packageName.startsWith('@types/')) return 'polyfill';

    const majors = new Set<number>();
    for (const r of requirements) {
      const parsed = semver.coerce(r.version);
      if (parsed) majors.add(parsed.major);
    }

    // Same major version — pnpm override is safe
    if (majors.size <= 1) return 'pnpm-override';

    // Different major versions — check API surface complexity heuristic
    const commonLargeAPIs = ['react', 'express', 'next', 'vue', 'angular', 'webpack'];
    if (commonLargeAPIs.some(lib => packageName.includes(lib))) {
      return 'docker-isolation';
    }

    return 'adapter';
  }
}
