"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiReferenceDocTemplate = void 0;
class ApiReferenceDocTemplate {
    category = 'api-reference';
    fileName = 'api-reference.md';
    isApplicable(k) {
        const publicSymbols = k.symbols.filter((s) => s.visibility === 'public');
        if (publicSymbols.length === 0) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No public symbols exported' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        const lines = ['# API Reference', ''];
        // Group by module
        const byModule = new Map();
        for (const sym of k.symbols.filter((s) => s.visibility === 'public')) {
            const mod = k.modules.find((m) => sym.filePath.startsWith(m.rootPath))?.name ?? 'global';
            if (!byModule.has(mod))
                byModule.set(mod, []);
            byModule.get(mod).push(sym);
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
                if (sym.returnType)
                    lines.push(`**Returns:** \`${sym.returnType}\``);
                lines.push('');
            }
        }
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'API Reference',
            sections: [{ id: 'api-reference', title: 'API Reference', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.ApiReferenceDocTemplate = ApiReferenceDocTemplate;
//# sourceMappingURL=ApiReferenceDocTemplate.js.map