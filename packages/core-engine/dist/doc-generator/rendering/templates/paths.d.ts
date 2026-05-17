/**
 * paths.ts — canonical output path constants for doc-generator templates.
 *
 * ADR_INFERRED_DIR is the only allowed write target for ADRDocTemplate (B5, v10.4).
 * Any code that writes ADR files MUST use this constant.
 */
export declare const DOCS_ROOT = "docs";
export declare const ADR_INFERRED_DIR = "adr-inferred";
export declare const OUTPUT_PATHS: {
    readonly architecture: "docs/architecture.md";
    readonly apiReference: "docs/api-reference.md";
    readonly developerGuide: "docs/developer-guide.md";
    readonly dataModel: "docs/data-model.md";
    readonly eventCatalogue: "docs/event-catalogue.md";
    readonly dependencyMap: "docs/dependency-map.md";
    readonly gettingStarted: "docs/getting-started.md";
    readonly glossary: "docs/glossary.md";
    readonly changelog: "docs/changelog.md";
    /** Per-module output: docs/modules/<name>.md */
    readonly moduleRef: (name: string) => string;
    /** Per-ADR output: docs/adr-inferred/<slug>.md */
    readonly adrInferred: (slug: string) => string;
    readonly adrInferredReadme: "docs/adr-inferred/README.md";
};
//# sourceMappingURL=paths.d.ts.map