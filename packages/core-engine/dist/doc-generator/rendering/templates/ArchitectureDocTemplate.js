"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArchitectureDocTemplate = void 0;
class ArchitectureDocTemplate {
    category = 'architecture';
    fileName = 'architecture.md';
    isApplicable(k) {
        if (k.modules.length === 0 && k.patterns.length === 0) {
            return { applicable: true, degradationLevel: 'skeleton', reason: 'No modules or patterns detected' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        const lines = [
            `# Architecture`,
            '',
            k.projectSummary ? k.projectSummary : '_No summary available._',
            '',
        ];
        if (k.modules.length > 0) {
            lines.push('## Modules', '');
            for (const mod of k.modules) {
                lines.push(`### ${mod.name}`);
                if (mod.description)
                    lines.push(mod.description);
                if (mod.purposeClass)
                    lines.push(`**Purpose:** ${mod.purposeClass}`);
                lines.push(`**Entry points:** ${mod.entryPoints.length > 0 ? mod.entryPoints.map((e) => `\`${e}\``).join(', ') : '_none_'}`, '');
            }
        }
        if (k.patterns.length > 0) {
            lines.push('## Architectural Patterns', '');
            for (const p of k.patterns.slice(0, 10)) {
                lines.push(`- **${p.name}** (confidence: ${(p.confidence * 100).toFixed(0)}%) — ${p.description}`);
            }
            lines.push('');
        }
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Architecture',
            sections: [{ id: 'architecture', title: 'Architecture', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.ArchitectureDocTemplate = ArchitectureDocTemplate;
//# sourceMappingURL=ArchitectureDocTemplate.js.map