"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChangelogDocTemplate = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const MAX_COMMITS = 500;
/**
 * ChangelogDocTemplate — Git log with GDPR-compliant author PII redaction (C13, v10.5).
 *
 * When redactAuthors=true (SaaS default): author name and email → '[redacted]'.
 * When redactAuthors=false (self-hosted CLI): author identity preserved.
 */
class ChangelogDocTemplate {
    redactAuthors;
    authorMap;
    category = 'changelog';
    fileName = 'changelog.md';
    constructor(redactAuthors = true, authorMap = new Map()) {
        this.redactAuthors = redactAuthors;
        this.authorMap = authorMap;
    }
    isApplicable(k) {
        const gitDir = node_path_1.default.join(k.rootPath, '.git');
        if (!(0, node_fs_1.existsSync)(gitDir)) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No .git directory found at rootPath' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        let commits = [];
        try {
            commits = await this.gitLog(k.rootPath, MAX_COMMITS, signal);
        }
        catch {
            const rendered = '# Changelog\n\n_Could not read git history._\n';
            return {
                fileName: this.fileName, category: this.category, title: 'Changelog',
                sections: [{ id: 'changelog', title: 'Changelog', content: rendered, order: 0 }],
                rendered,
            };
        }
        signal?.throwIfAborted();
        const lines = ['# Changelog', '', `${commits.length} commits (capped at ${MAX_COMMITS}).`, ''];
        lines.push('| Hash | Date | Author | Subject |');
        lines.push('|------|------|--------|---------|');
        for (const c of commits) {
            const author = this.resolveAuthor(c.email, c.author);
            lines.push(`| \`${c.hash.slice(0, 8)}\` | ${c.date.slice(0, 10)} | ${author} | ${escapeMarkdown(c.subject)} |`);
        }
        lines.push('');
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Changelog',
            sections: [{ id: 'changelog', title: 'Changelog', content: rendered, order: 0 }],
            rendered,
        };
    }
    resolveAuthor(email, name) {
        if (!this.redactAuthors)
            return escapeMarkdown(name);
        return this.authorMap.get(email) ?? '[redacted]';
    }
    gitLog(cwd, maxCommits, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const args = ['log', `--max-count=${maxCommits}`, '--format=%H|%s|%ae|%an|%aI'];
            const proc = (0, node_child_process_1.spawn)('git', args, { cwd, stdio: 'pipe' });
            let out = '';
            const onAbort = () => {
                proc.kill();
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            proc.stdout.on('data', (d) => { out += d.toString(); });
            proc.on('close', (code) => {
                signal?.removeEventListener('abort', onAbort);
                if (code !== 0) {
                    reject(new Error(`git log exited ${code}`));
                    return;
                }
                const entries = out.trim().split('\n').filter(Boolean).map((line) => {
                    const [hash = '', subject = '', email = '', author = '', date = ''] = line.split('|');
                    return { hash, subject, email, author, date };
                });
                resolve(entries);
            });
            proc.on('error', (err) => {
                signal?.removeEventListener('abort', onAbort);
                reject(err);
            });
        });
    }
}
exports.ChangelogDocTemplate = ChangelogDocTemplate;
function escapeMarkdown(s) {
    return s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
//# sourceMappingURL=ChangelogDocTemplate.js.map