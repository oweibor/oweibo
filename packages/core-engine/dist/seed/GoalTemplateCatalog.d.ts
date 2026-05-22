import type { ISubGoal } from '@oweibo/core-contracts';
export interface GoalTemplate {
    readonly templateId: string;
    readonly catalogVersion: string;
    readonly triggerSummary: string;
    readonly subGoalSkeleton: readonly ISubGoal[];
    readonly applicableTo: {
        readonly templates: readonly string[];
        readonly industries?: readonly string[];
    };
}
export interface CatalogFilter {
    readonly templateSlug: string;
    readonly industry?: string;
}
export declare class GoalTemplateCatalog {
    private readonly entries;
    private constructor();
    static loadFromDirectory(dir: string): Promise<GoalTemplateCatalog>;
    static fromEntries(entries: readonly GoalTemplate[]): GoalTemplateCatalog;
    static defaultDirectory(): string;
    forTenant(filter: CatalogFilter): GoalTemplate[];
    get size(): number;
    all(): readonly GoalTemplate[];
}
//# sourceMappingURL=GoalTemplateCatalog.d.ts.map