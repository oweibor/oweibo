import type { ConnectorCatalogEntry, ConnectorCapability } from '@oweibo/core-contracts';
export declare class ConnectorRegistry {
    private readonly entries;
    private constructor();
    static loadFromDirectory(dir: string): Promise<ConnectorRegistry>;
    static fromEntries(entries: readonly ConnectorCatalogEntry[]): ConnectorRegistry;
    static defaultDirectory(): string;
    /** Look up a single catalog entry by id. Returns null if not found. */
    get(connectorId: string): ConnectorCatalogEntry | null;
    /** Look up a specific capability across the catalog. */
    getCapability(connectorId: string, capabilityId: string): ConnectorCapability | null;
    /**
     * Recommendation for a tenant: entries whose recommendedFor includes the
     * tenant's templateSlug or `'*'`. Order is the order entries were loaded,
     * which is filesystem-alphabetic from the catalog directory.
     */
    recommend(templateSlug: string): ConnectorCatalogEntry[];
    /** All loaded catalog entries. */
    all(): readonly ConnectorCatalogEntry[];
    get size(): number;
}
//# sourceMappingURL=ConnectorRegistry.d.ts.map