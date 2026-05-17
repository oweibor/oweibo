"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeveloperGuideDocTemplate = void 0;
class DeveloperGuideDocTemplate {
    category = 'developer-guide';
    fileName = 'developer-guide.md';
    isApplicable(_k) {
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        const lines = ['# Developer Guide', ''];
        if (k.gettingStarted) {
            lines.push('## Getting Started', '', k.gettingStarted, '');
        }
        if (k.conventions.length > 0) {
            lines.push('## Coding Conventions', '');
            for (const conv of k.conventions) {
                lines.push(`### ${conv.area}`, conv.description, '');
                if (conv.evidence.length > 0) {
                    lines.push('**Examples:**');
                    for (const e of conv.evidence.slice(0, 3))
                        lines.push(`- \`${e}\``);
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
            title: 'Developer Guide',
            sections: [{ id: 'developer-guide', title: 'Developer Guide', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.DeveloperGuideDocTemplate = DeveloperGuideDocTemplate;
//# sourceMappingURL=DeveloperGuideDocTemplate.js.map