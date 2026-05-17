"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModuleReferenceDocTemplate = void 0;
/**
 * Generates one docs/modules/<name>.md per module boundary.
 * fileName is the first module's file (multi-render templates override this per-call).
 */
class ModuleReferenceDocTemplate {
    category = 'module-reference';
    fileName = 'modules/index.md';
    isApplicable(k) {
        if (k.modules.length === 0) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No module boundaries detected' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        // Render all modules into a single combined document (orchestrator splits by module)
        const sections = k.modules.map((mod, idx) => {
            const lines = [
                `# Module: ${mod.name}`,
                '',
                mod.description ?? '_No description available._',
                '',
            ];
            if (mod.purposeClass)
                lines.push(`**Purpose:** ${mod.purposeClass}`, '');
            if (mod.entryPoints.length > 0) {
                lines.push('## Entry Points', '');
                for (const ep of mod.entryPoints)
                    lines.push(`- \`${ep}\``);
                lines.push('');
            }
            if (mod.publicApi.length > 0) {
                lines.push('## Public API', '');
                for (const sym of mod.publicApi.slice(0, 30)) {
                    lines.push(`- **\`${sym.name}\`** (\`${sym.kind}\`)${sym.rawDocumentation ? ` — ${sym.rawDocumentation.split('\n')[0]}` : ''}`);
                }
                lines.push('');
            }
            if (mod.dependencies.length > 0) {
                lines.push('## Dependencies', '');
                for (const dep of mod.dependencies) {
                    lines.push(`- → \`${dep.targetModule}\` (${dep.type}, ${dep.strength})`);
                }
                lines.push('');
            }
            return {
                id: `module-${mod.name}`,
                title: mod.name,
                content: lines.join('\n'),
                order: idx,
            };
        });
        const rendered = sections.map((s) => s.content).join('\n---\n\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Module Reference',
            sections,
            rendered,
        };
    }
}
exports.ModuleReferenceDocTemplate = ModuleReferenceDocTemplate;
//# sourceMappingURL=ModuleReferenceDocTemplate.js.map