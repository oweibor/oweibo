"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GlossaryDocTemplate = void 0;
class GlossaryDocTemplate {
    category = 'glossary';
    fileName = 'glossary.md';
    isApplicable(k) {
        const withDocs = k.symbols.filter((s) => s.rawDocumentation);
        if (withDocs.length === 0) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No JSDoc/docstring found to mine terms from' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        // Mine domain terms: interface names + class names with JSDoc
        const terms = new Map();
        for (const sym of k.symbols) {
            if ((sym.kind === 'interface' || sym.kind === 'class') && sym.rawDocumentation) {
                const firstLine = sym.rawDocumentation
                    .replace(/\/\*\*?|\*\/|\*/g, '')
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)[0] ?? '';
                if (firstLine)
                    terms.set(sym.name, firstLine);
            }
        }
        const lines = ['# Glossary', '', `Domain terms mined from ${terms.size} documented types.`, ''];
        const sorted = Array.from(terms.entries()).sort(([a], [b]) => a.localeCompare(b));
        for (const [term, def] of sorted) {
            lines.push(`**${term}**`, `  ${def}`, '');
        }
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Glossary',
            sections: [{ id: 'glossary', title: 'Glossary', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.GlossaryDocTemplate = GlossaryDocTemplate;
//# sourceMappingURL=GlossaryDocTemplate.js.map