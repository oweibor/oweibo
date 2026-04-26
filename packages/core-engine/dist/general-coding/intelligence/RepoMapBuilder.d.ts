/**
 * RepoMapBuilder — produces a tiered, token-budgeted structural map of the entire repo.
 * Injected as a fixed prefix into every GeneralCodingAgent prompt.
 *
 * G14 fix: Three-tier progressive summarisation strategy.
 * Tier 1 (≤150 source files)  — full export skeleton: class names + all public method signatures.
 * Tier 2 (151–500 source files) — module-boundary summary: file path + exported type names only.
 * Tier 3 (500+ source files)  — directory tree only with file counts per directory.
 *
 * Budget: 12,000 chars (~3,000 tokens) per tier.
 */
export declare class RepoMapBuilder {
    private readonly repoRoot;
    private static readonly TIER1_MAX_FILES;
    private static readonly TIER2_MAX_FILES;
    private static readonly CHAR_BUDGET;
    constructor(repoRoot: string);
    build(repoRoot?: string): Promise<string>;
    private buildTiered;
    private buildDirectoryTree;
    private extractExports;
    private isExported;
    private buildFiletreeOnly;
}
//# sourceMappingURL=RepoMapBuilder.d.ts.map