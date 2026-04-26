import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';

export class GlossaryDocTemplate implements IDocTemplate {
  readonly category = 'glossary' as const;
  readonly fileName = 'glossary.md';

  isApplicable(k: CodebaseKnowledge): ApplicabilityResult {
    const withDocs = k.symbols.filter((s) => s.rawDocumentation);
    if (withDocs.length === 0) {
      return { applicable: false, degradationLevel: 'skipped', reason: 'No JSDoc/docstring found to mine terms from' };
    }
    return { applicable: true, degradationLevel: 'full' };
  }

  async render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument> {
    signal?.throwIfAborted();

    // Mine domain terms: interface names + class names with JSDoc
    const terms = new Map<string, string>();
    for (const sym of k.symbols) {
      if ((sym.kind === 'interface' || sym.kind === 'class') && sym.rawDocumentation) {
        const firstLine = sym.rawDocumentation
          .replace(/\/\*\*?|\*\/|\*/g, '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)[0] ?? '';
        if (firstLine) terms.set(sym.name, firstLine);
      }
    }

    const lines: string[] = ['# Glossary', '', `Domain terms mined from ${terms.size} documented types.`, ''];

    const sorted = Array.from(terms.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [term, def] of sorted) {
      lines.push(`**${term}**`, `  ${def}`, '');
    }

    const rendered = lines.join('\n');
    return {
      fileName: this.fileName,
      category: this.category,
      title:    'Glossary',
      sections: [{ id: 'glossary', title: 'Glossary', content: rendered, order: 0 }],
      rendered,
    };
  }
}
