import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';

export class DependencyMapDocTemplate implements IDocTemplate {
  readonly category = 'dependency-map' as const;
  readonly fileName = 'dependency-map.md';

  isApplicable(k: CodebaseKnowledge): ApplicabilityResult {
    if (k.externalDependencies.length === 0) {
      return { applicable: false, degradationLevel: 'skipped', reason: 'No external dependencies found' };
    }
    return { applicable: true, degradationLevel: k.externalDependencies.some((d) => d.versionSource === 'lockfile') ? 'full' : 'partial' };
  }

  async render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument> {
    signal?.throwIfAborted();

    const prod = k.externalDependencies.filter((d) => !d.isDev);
    const dev  = k.externalDependencies.filter((d) => d.isDev);

    const lines: string[] = ['# Dependency Map', ''];
    lines.push(`**${prod.length}** production | **${dev.length}** development`, '');

    if (prod.length > 0) {
      lines.push('## Production Dependencies', '');
      lines.push('| Package | Version | Source | License | Purpose |');
      lines.push('|---------|---------|--------|---------|---------|');
      for (const dep of prod) {
        lines.push(`| \`${dep.name}\` | ${dep.version} | ${dep.versionSource} | ${dep.license ?? '?'} | ${dep.purpose ?? ''} |`);
      }
      lines.push('');
    }

    if (dev.length > 0) {
      lines.push('## Development Dependencies', '');
      lines.push('| Package | Version | Purpose |');
      lines.push('|---------|---------|---------|');
      for (const dep of dev) {
        lines.push(`| \`${dep.name}\` | ${dep.version} | ${dep.purpose ?? ''} |`);
      }
      lines.push('');
    }

    if (k.internalDependencyGraph.length > 0) {
      lines.push('## Internal Module Graph', '');
      for (const edge of k.internalDependencyGraph.slice(0, 30)) {
        lines.push(`- \`${edge.targetModule}\` ← ${edge.type} (${edge.strength})`);
      }
      lines.push('');
    }

    const rendered = lines.join('\n');
    return {
      fileName: this.fileName,
      category: this.category,
      title:    'Dependency Map',
      sections: [{ id: 'dependency-map', title: 'Dependency Map', content: rendered, order: 0 }],
      rendered,
    };
  }
}
