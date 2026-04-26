import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';

export class DeveloperGuideDocTemplate implements IDocTemplate {
  readonly category = 'developer-guide' as const;
  readonly fileName = 'developer-guide.md';

  isApplicable(_k: CodebaseKnowledge): ApplicabilityResult {
    return { applicable: true, degradationLevel: 'full' };
  }

  async render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument> {
    signal?.throwIfAborted();

    const lines: string[] = ['# Developer Guide', ''];

    if (k.gettingStarted) {
      lines.push('## Getting Started', '', k.gettingStarted, '');
    }

    if (k.conventions.length > 0) {
      lines.push('## Coding Conventions', '');
      for (const conv of k.conventions) {
        lines.push(`### ${conv.area}`, conv.description, '');
        if (conv.evidence.length > 0) {
          lines.push('**Examples:**');
          for (const e of conv.evidence.slice(0, 3)) lines.push(`- \`${e}\``);
          lines.push('');
        }
      }
    }

    const devDeps = k.externalDependencies.filter((d) => d.isDev);
    if (devDeps.length > 0) {
      lines.push('## Development Dependencies', '');
      lines.push('| Package | Version | Purpose |');
      lines.push('|---------|---------|---------|');
      for (const dep of devDeps.slice(0, 20)) {
        lines.push(`| \`${dep.name}\` | ${dep.version} | ${dep.purpose ?? ''} |`);
      }
      lines.push('');
    }

    const rendered = lines.join('\n');
    return {
      fileName: this.fileName,
      category: this.category,
      title:    'Developer Guide',
      sections: [{ id: 'developer-guide', title: 'Developer Guide', content: rendered, order: 0 }],
      rendered,
    };
  }
}
