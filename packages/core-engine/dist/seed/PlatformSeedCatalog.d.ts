import type { MemoryKind } from '@oweibo/core-contracts';
export interface PlatformSeedMemory {
    readonly seedId: string;
    readonly catalogVersion: string;
    readonly kind: MemoryKind;
    readonly summary: string;
    readonly body?: string;
    /** 0..1 — capped at 0.6 by convention so organic memories can outrank. */
    readonly importance: number;
    readonly tags: readonly string[];
    readonly applicableTo: {
        /** Template slugs that should receive this seed. `'*'` = all tenants. */
        readonly templates: readonly string[];
        readonly industries?: readonly string[];
    };
}
export interface CatalogFilter {
    readonly templateSlug: string;
    readonly industry?: string;
}
export declare class PlatformSeedCatalog {
    private readonly entries;
    private constructor();
    /**
     * Load the catalog from a directory of JSON files. Files are expected to be
     * objects of shape `{ entries: PlatformSeedMemory[] }` — one file per
     * MemoryKind for review tractability, but the runtime only sees the merged
     * array. Throws on parse error: a bad catalog should fail the worker, not
     * silently ship empty data.
     */
    static loadFromDirectory(dir: string): Promise<PlatformSeedCatalog>;
    /** Construct from an in-memory list. Used by tests. */
    static fromEntries(entries: readonly PlatformSeedMemory[]): PlatformSeedCatalog;
    /**
     * Default catalog directory shipped alongside this module. Tests pass an
     * explicit directory to `loadFromDirectory`; production callers can use
     * this helper. Resolves to `src/seed/seed-memories` in test (ts-jest sees
     * __dirname under src) and `dist/seed/seed-memories` at runtime.
     */
    static defaultDirectory(): string;
    /** Filter entries that apply to the given tenant context. */
    forTenant(filter: CatalogFilter): PlatformSeedMemory[];
    /** Total number of loaded entries. */
    get size(): number;
    /** Returns the full set — used by tests. */
    all(): readonly PlatformSeedMemory[];
}
//# sourceMappingURL=PlatformSeedCatalog.d.ts.map