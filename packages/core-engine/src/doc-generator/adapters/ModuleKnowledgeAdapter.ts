/**
 * ModuleKnowledgeAdapter — converts CodebaseKnowledge → ModuleKnowledge.
 *
 * Enables DocGeneratorPipeline output to feed the factory DocumentationAgent
 * in hybrid flows (§4.3.6, v10.5). Reverse adapter (fromModuleKnowledge) is
 * not needed in P1.
 */

import type {
  CodebaseKnowledge,
  ModuleBoundary,
  ModuleKnowledge,
  ModuleEntityDoc,
  ModuleEntityField,
  EndpointDoc,
  EventDoc,
  InvariantDoc,
  ExtensionPointDoc,
  GlossaryEntry,
  SymbolInfo,
  EnrichedCallEdge,
} from '@oweibo/core-contracts';

export function toModuleKnowledge(
  knowledge:    CodebaseKnowledge,
  targetModule: ModuleBoundary,
): ModuleKnowledge {
  const publicApi = targetModule.publicApi ?? [];

  return {
    moduleName:        targetModule.name,
    version:           readVersionFromPackageJson(knowledge, targetModule.rootPath),
    generatedAt:       knowledge.analyzedAt,
    domainDescription: targetModule.description ?? knowledge.projectSummary,
    entities:          mapToModuleEntityDocs(publicApi),
    endpoints:         mapCallGraphToEndpoints(knowledge.callGraph, targetModule),
    emittedEvents:     filterEvents(knowledge.callGraph, targetModule, 'event-emit'),
    consumedEvents:    filterEvents(knowledge.callGraph, targetModule, 'event-subscribe'),
    invariants:        mineInvariantsFromComments(publicApi),
    extensionPoints:   detectExtensionPoints(publicApi),
    userFlows:         [],
    glossary:          mineGlossaryFromDocs(publicApi, knowledge.projectSummary),
    exampleUsages:     [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readVersionFromPackageJson(
  knowledge: CodebaseKnowledge,
  rootPath:  string,
): string {
  const dep = knowledge.externalDependencies.find(
    (d) => d.name === 'self' || d.name === rootPath,
  );
  return dep?.version ?? '1.0.0';
}

function mapToModuleEntityDocs(symbols: readonly SymbolInfo[]): readonly ModuleEntityDoc[] {
  return symbols
    .filter((s) => s.kind === 'interface' || s.kind === 'class' || s.kind === 'type')
    .map((s): ModuleEntityDoc => ({
      name:     s.name,
      filePath: s.filePath,
      fields:   mapFields(s),
    }));
}

function mapFields(symbol: SymbolInfo): readonly ModuleEntityField[] {
  if (!symbol.parameters) return [];
  return symbol.parameters.map((p): ModuleEntityField => ({
    name:     p.name,
    type:     p.type ?? 'unknown',
    optional: p.optional ?? false,
  }));
}

function mapCallGraphToEndpoints(
  callGraph:    readonly EnrichedCallEdge[],
  targetModule: ModuleBoundary,
): readonly EndpointDoc[] {
  // Infer endpoints from direct calls whose callee name looks like an HTTP handler
  return callGraph
    .filter(
      (e) =>
        e.callerFile.startsWith(targetModule.rootPath) &&
        /^(get|post|put|delete|patch)[A-Z]/.test(e.calleeSymbol),
    )
    .map((e): EndpointDoc => {
      const method = e.calleeSymbol.slice(0, e.calleeSymbol.search(/[A-Z]/)).toUpperCase() as EndpointDoc['method'];
      return {
        method,
        path:        `/${e.calleeSymbol}`,
        filePath:    e.callerFile,
        description: e.calleeSymbol,
      };
    });
}

function filterEvents(
  callGraph:    readonly EnrichedCallEdge[],
  targetModule: ModuleBoundary,
  kind:         'event-emit' | 'event-subscribe',
): readonly EventDoc[] {
  return callGraph
    .filter(
      (e) =>
        e.callType === kind &&
        e.callerFile.startsWith(targetModule.rootPath),
    )
    .map((e): EventDoc => ({
      eventType: e.calleeSymbol,
      filePath:  e.callerFile,
    }));
}

function mineInvariantsFromComments(symbols: readonly SymbolInfo[]): readonly InvariantDoc[] {
  const results: InvariantDoc[] = [];
  for (const s of symbols) {
    if (!s.rawDocumentation) continue;
    const invariantLines = s.rawDocumentation
      .split('\n')
      .filter((l) => /@invariant|@assert|INVARIANT:/i.test(l));
    for (const line of invariantLines) {
      results.push({
        description: line.replace(/@invariant|@assert|INVARIANT:/gi, '').trim(),
        source:      'annotation',
        filePath:    s.filePath,
      });
    }
  }
  return results;
}

function detectExtensionPoints(symbols: readonly SymbolInfo[]): readonly ExtensionPointDoc[] {
  return symbols
    .filter((s) => /hook|plugin|extension|register|middleware/i.test(s.name))
    .map((s): ExtensionPointDoc => ({
      hookName:    s.name,
      filePath:    s.filePath,
      description: s.rawDocumentation?.split('\n')[0] ?? undefined,
    }));
}

function mineGlossaryFromDocs(
  symbols:        readonly SymbolInfo[],
  projectSummary: string,
): readonly GlossaryEntry[] {
  const seen = new Set<string>();
  const entries: GlossaryEntry[] = [];

  for (const s of symbols) {
    if (!s.rawDocumentation || seen.has(s.name)) continue;
    const first = s.rawDocumentation.split('\n').find((l) => l.trim() && !l.startsWith('@'));
    if (!first) continue;
    seen.add(s.name);
    entries.push({ term: s.name, definition: first.trim().slice(0, 200) });
  }

  if (projectSummary && !seen.has('Project')) {
    entries.unshift({ term: 'Project', definition: projectSummary.slice(0, 200) });
  }

  return entries;
}
