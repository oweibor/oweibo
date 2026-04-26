import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge, SymbolInfo } from '@oweibo/core-contracts';

export class ApiReferenceDocTemplate implements IDocTemplate {
  readonly category = 'api-reference' as const;
  readonly fileName = 'api-reference.md';

  isApplicable(k: CodebaseKnowledge): ApplicabilityResult {
    const publicSymbols = k.symbols.filter((s) => s.visibility === 'public');
    if (publicSymbols.length === 0) {
      return { applicable: false, degradationLevel: 'skipped', reason: 'No public symbols exported' };
    }
    return { applicable: true, degradationLevel: 'full' };
  }

  async render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument> {
    signal?.throwIfAborted();

    const lines: string[] = ['# API Reference', ''];

    // Group by module
    const byModule = new Map<string, SymbolInfo[]>();
    for (const sym of k.symbols.filter((s) => s.visibility === 'public')) {
      const mod = k.modules.find((m) => sym.filePath.startsWith(m.rootPath))?.name ?? 'global';
      if (!byModule.has(mod)) byModule.set(mod, []);
      byModule.get(mod)!.push(sym);
    }

    for (const [modName, symbols] of byModule) {
      lines.push(`## ${modName}`, '');
      for (const sym of symbols) {
        lines.push(`### \`${sym.name}\``);
        lines.push(`**Kind:** ${sym.kind} | **File:** \`${sym.filePath.split('/').pop()}\``);
        if (sym.rawDocumentation) {
          lines.push('', sym.rawDocumentation.split('\n').map((l) => `> ${l}`).join('\n'));
        }
        if (sym.parameters?.length) {
          lines.push('', '**Parameters:**');
          for (const p of sym.parameters) {
            lines.push(`- \`${p.name}: ${p.type}\`${p.optional ? ' _(optional)_' : ''}`);
          }
        }
        if (sym.returnType) lines.push(`**Returns:** \`${sym.returnType}\``);
        lines.push('');
      }
    }

    const rendered = lines.join('\n');
    return {
      fileName: this.fileName,
      category: this.category,
      title:    'API Reference',
      sections: [{ id: 'api-reference', title: 'API Reference', content: rendered, order: 0 }],
      rendered,
    };
  }
}
