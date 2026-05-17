"use strict";
/**
 * paths.ts — canonical output path constants for doc-generator templates.
 *
 * ADR_INFERRED_DIR is the only allowed write target for ADRDocTemplate (B5, v10.4).
 * Any code that writes ADR files MUST use this constant.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OUTPUT_PATHS = exports.ADR_INFERRED_DIR = exports.DOCS_ROOT = void 0;
exports.DOCS_ROOT = 'docs';
exports.ADR_INFERRED_DIR = 'adr-inferred';
exports.OUTPUT_PATHS = {
    architecture: `${exports.DOCS_ROOT}/architecture.md`,
    apiReference: `${exports.DOCS_ROOT}/api-reference.md`,
    developerGuide: `${exports.DOCS_ROOT}/developer-guide.md`,
    dataModel: `${exports.DOCS_ROOT}/data-model.md`,
    eventCatalogue: `${exports.DOCS_ROOT}/event-catalogue.md`,
    dependencyMap: `${exports.DOCS_ROOT}/dependency-map.md`,
    gettingStarted: `${exports.DOCS_ROOT}/getting-started.md`,
    glossary: `${exports.DOCS_ROOT}/glossary.md`,
    changelog: `${exports.DOCS_ROOT}/changelog.md`,
    /** Per-module output: docs/modules/<name>.md */
    moduleRef: (name) => `${exports.DOCS_ROOT}/modules/${name}.md`,
    /** Per-ADR output: docs/adr-inferred/<slug>.md */
    adrInferred: (slug) => `${exports.DOCS_ROOT}/${exports.ADR_INFERRED_DIR}/${slug}.md`,
    adrInferredReadme: `${exports.DOCS_ROOT}/${exports.ADR_INFERRED_DIR}/README.md`,
};
//# sourceMappingURL=paths.js.map