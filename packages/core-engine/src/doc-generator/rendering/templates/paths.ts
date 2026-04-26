/**
 * paths.ts — canonical output path constants for doc-generator templates.
 *
 * ADR_INFERRED_DIR is the only allowed write target for ADRDocTemplate (B5, v10.4).
 * Any code that writes ADR files MUST use this constant.
 */

export const DOCS_ROOT        = 'docs';
export const ADR_INFERRED_DIR = 'adr-inferred';

export const OUTPUT_PATHS = {
  architecture:   `${DOCS_ROOT}/architecture.md`,
  apiReference:   `${DOCS_ROOT}/api-reference.md`,
  developerGuide: `${DOCS_ROOT}/developer-guide.md`,
  dataModel:      `${DOCS_ROOT}/data-model.md`,
  eventCatalogue: `${DOCS_ROOT}/event-catalogue.md`,
  dependencyMap:  `${DOCS_ROOT}/dependency-map.md`,
  gettingStarted: `${DOCS_ROOT}/getting-started.md`,
  glossary:       `${DOCS_ROOT}/glossary.md`,
  changelog:      `${DOCS_ROOT}/changelog.md`,
  /** Per-module output: docs/modules/<name>.md */
  moduleRef:      (name: string) => `${DOCS_ROOT}/modules/${name}.md`,
  /** Per-ADR output: docs/adr-inferred/<slug>.md */
  adrInferred:    (slug: string) => `${DOCS_ROOT}/${ADR_INFERRED_DIR}/${slug}.md`,
  adrInferredReadme: `${DOCS_ROOT}/${ADR_INFERRED_DIR}/README.md`,
} as const;
