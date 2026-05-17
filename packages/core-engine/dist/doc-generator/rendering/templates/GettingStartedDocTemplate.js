"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GettingStartedDocTemplate = void 0;
class GettingStartedDocTemplate {
    category = 'getting-started';
    fileName = 'getting-started.md';
    isApplicable(_k) {
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        const lines = ['# Getting Started', ''];
        if (k.gettingStarted) {
            lines.push(k.gettingStarted, '');
        }
        else {
            // Skeleton when LLM skipped
            lines.push('## Prerequisites', '');
            const langs = k.languages.filter((l) => l !== 'unknown');
            if (langs.includes('typescript') || langs.includes('javascript')) {
                lines.push('- Node.js ≥ 18', '- pnpm ≥ 8', '');
            }
            if (langs.includes('python'))
                lines.push('- Python ≥ 3.10', '');
            if (langs.includes('go'))
                lines.push('- Go ≥ 1.21', '');
            lines.push('## Installation', '', '```bash', '# Clone the repository', `git clone <repo-url>`, 'cd ' + k.projectName, '```', '');
            lines.push('## Running', '', '_See project README for details._', '');
        }
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Getting Started',
            sections: [{ id: 'getting-started', title: 'Getting Started', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.GettingStartedDocTemplate = GettingStartedDocTemplate;
//# sourceMappingURL=GettingStartedDocTemplate.js.map