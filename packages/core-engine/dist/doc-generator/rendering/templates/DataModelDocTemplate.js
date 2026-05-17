"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataModelDocTemplate = void 0;
class DataModelDocTemplate {
    category = 'data-model';
    fileName = 'data-model.md';
    isApplicable(k) {
        const dataSymbols = k.symbols.filter((s) => s.kind === 'interface' || s.kind === 'type');
        if (dataSymbols.length === 0) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No interface or type exports found' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        const dataSymbols = k.symbols.filter((s) => s.kind === 'interface' || s.kind === 'type');
        const lines = ['# Data Models', '', `${dataSymbols.length} types and interfaces across ${k.totalFiles} files.`, ''];
        for (const sym of dataSymbols) {
            lines.push(`## \`${sym.name}\``);
            lines.push(`**Kind:** ${sym.kind} | **File:** \`${sym.filePath.split('/').pop()}\``);
            if (sym.rawDocumentation) {
                lines.push('', sym.rawDocumentation.split('\n').slice(0, 3).map((l) => `> ${l}`).join('\n'));
            }
            if (sym.members?.length) {
                lines.push('', '**Members:**');
                for (const m of sym.members.slice(0, 10)) {
                    lines.push(`- \`${m.name}\`: ${m.returnType ?? m.kind}`);
                }
            }
            lines.push('');
        }
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Data Models',
            sections: [{ id: 'data-models', title: 'Data Models', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.DataModelDocTemplate = DataModelDocTemplate;
//# sourceMappingURL=DataModelDocTemplate.js.map